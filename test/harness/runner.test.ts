import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXECUTOR_SYSTEM_PROMPT, runMission, parseDispute, isTransientProviderError } from "../../src/harness/runner.js";
import { MockEngine, type ScriptResolver } from "../../src/engine/mock.js";
import { initRepo, commitAll } from "../../src/harness/checkpoint.js";
import { parseMission, parseChains } from "../../src/contract/schema.js";
import { readTrace } from "../../src/harness/trace.js";

const chains = parseChains(`
chains:
  cheap:
    executor: "qwen/qwen3-coder"
    fallback: "deepseek/deepseek-chat"
    knight: "z-ai/glm-5.2"
prices:
  "qwen/qwen3-coder": { in: 0.2, out: 0.8 }
  "deepseek/deepseek-chat": { in: 0.14, out: 0.28 }
  "z-ai/glm-5.2": { in: 0.95, out: 3.00 }
`);

let repo: string;
let clock: number;
beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "squire-run-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "target.ts"), "export const v = 0;\n");
  writeFileSync(join(repo, "check.sh"), 'grep -q "v = 1" src/target.ts\n');
  await initRepo(repo);
  clock = 0;
});

function run(missionYaml: string, resolveScript: ScriptResolver) {
  const mission = parseMission(missionYaml);
  return runMission({
    mission,
    chains,
    engine: new MockEngine({ resolveScript }),
    workdir: repo,
    missionId: "m-test",
    tracePath: join(repo, ".squire", "trace.jsonl"),
    now: () => ++clock,
  });
}

const oneNode = `
goal: "set v to 1"
budget_usd: 5
chain: cheap
nodes:
  - id: fix
    brief: "edit src/target.ts so v = 1"
    context_globs: ["src/**"]
    blast_radius: ["src/**"]
    done_check: "bash check.sh"
    budget_usd: 1
`;

describe("isTransientProviderError", () => {
  it("flags 5xx / 429 / overload / connection blips as transient", () => {
    for (const m of ['500 "Internal Server Error"', "429 Too Many Requests", "503 Service Unavailable", "provider overloaded", "ECONNRESET", "socket hang up", "fetch failed"]) {
      expect(isTransientProviderError(m)).toBe(true);
    }
  });
  it("does NOT flag a model/work failure or empty message", () => {
    expect(isTransientProviderError("does not export required symbol(s): findArbitrage")).toBe(false);
    expect(isTransientProviderError("content_filter")).toBe(false);
    expect(isTransientProviderError(undefined)).toBe(false);
  });
});

describe("runMission", () => {
  it("tells executors to write literal CommonJS source for JS files", () => {
    expect(EXECUTOR_SYSTEM_PROMPT).toContain("content argument is the exact file body");
    expect(EXECUTOR_SYSTEM_PROMPT).toContain("module.exports");
  });

  it("RETRIES a transient provider error (no work done) and still passes on the same rung", async () => {
    // The provider 500s on the first call (before any tool ran); the retry succeeds. The node
    // must pass on rung 1 — a transient blip must NOT burn an escalation rung.
    let call = 0;
    const result = await run(oneNode, () => {
      call += 1;
      if (call === 1) return { steps: [{ error: "500 \"Internal Server Error\"" }] };
      return {
        steps: [
          { tool: "edit", args: { path: "src/target.ts", oldString: "v = 0", newString: "v = 1" } },
          { usage: { in: 1000, out: 200 } },
          { tool: "bash", args: { command: "bash check.sh" } },
          { done: "fixed" },
        ],
      };
    });
    expect(result.completed).toBe(true);
    expect(result.committedNodeIds).toEqual(["fix"]);
    const trace = readTrace(result.tracePath);
    expect(trace.some((e) => e.kind === "provider_retry")).toBe(true);
    // It passed on rung 1 — no escalation to the fallback model.
    expect(trace.some((e) => e.kind === "escalate")).toBe(false);
  });

  it("completes a node on rung 1, commits, and writes a trace", async () => {
    const result = await run(oneNode, () => ({
      steps: [
        { tool: "edit", args: { path: "src/target.ts", oldString: "v = 0", newString: "v = 1" } },
        { usage: { in: 1000, out: 200 } },
        { tool: "bash", args: { command: "bash check.sh" } },
        { done: "edited src/target.ts and ran bash check.sh — passes" },
      ],
    }));
    expect(result.completed).toBe(true);
    expect(result.committedNodeIds).toEqual(["fix"]);
    expect(readFileSync(join(repo, "src", "target.ts"), "utf8")).toContain("v = 1");
    expect(result.totalCostUsd).toBeGreaterThan(0);
    const kinds = readTrace(result.tracePath).map((e) => e.kind);
    expect(kinds).toContain("mission_start");
    expect(kinds).toContain("node_pass");
    expect(kinds).toContain("checkpoint");
    expect(kinds).toContain("mission_end");
  });

  it("rung 1 fails the gate; the SAME model REPAIRS in place on rung 2 (stays cheap, no escalation)", async () => {
    const result = await run(oneNode, (_id, rung) => {
      if (rung === 1) {
        // does nothing useful — gate will fail
        return { steps: [{ text: "I think it's fine" }, { done: "all good" }] };
      }
      // rung 2 is the executor's REPAIR turn — same model, gate error in context, fixes it
      return {
        steps: [
          { tool: "edit", args: { path: "src/target.ts", oldString: "v = 0", newString: "v = 1" } },
          { tool: "bash", args: { command: "bash check.sh" } },
          { done: "fixed on repair" },
        ],
      };
    });
    expect(result.completed).toBe(true);
    const node = result.nodes[0]!;
    expect(node.maxRung).toBe(2); // recovered on the repair rung — never reached the fallback model
    const trace = readTrace(result.tracePath);
    const kinds = trace.map((e) => e.kind);
    expect(kinds).toContain("node_fail");
    expect(kinds).toContain("repair"); // a same-model repair ran (not a reset to green)
    // the rung-2 repair ran the SAME (executor) model, not the fallback
    expect(trace.find((e) => e.kind === "node_start" && e.rung === 2)!.payload).toMatchObject({
      model: "qwen/qwen3-coder",
    });
  });

  it("when the repair also fails, escalates to a FRESH fallback model that resets and passes", async () => {
    const result = await run(oneNode, (_id, rung) => {
      // rungs 1 & 2 are both the executor (attempt + its repair) — both useless here
      if (rung <= 2) return { steps: [{ done: "still wrong" }] };
      // rung 3 is the fallback model, a FRESH attempt (reset to green) that fixes it
      return {
        steps: [
          { tool: "edit", args: { path: "src/target.ts", oldString: "v = 0", newString: "v = 1" } },
          { done: "fixed on the fallback" },
        ],
      };
    });
    expect(result.completed).toBe(true);
    expect(result.nodes[0]!.maxRung).toBe(3); // executor + its repair exhausted, then the fallback
    const trace = readTrace(result.tracePath);
    const kinds = trace.map((e) => e.kind);
    expect(kinds).toContain("repair"); // the rung-2 repair was attempted first
    expect(kinds).toContain("escalate"); // then escalated to the fallback
    expect(kinds).toContain("reset"); // the fresh fallback rung reset to green
    expect(trace.find((e) => e.kind === "node_start" && e.rung === 3)!.payload).toMatchObject({
      model: "deepseek/deepseek-chat",
    });
  });

  it("resets after a failed attempt so a bad edit does not persist", async () => {
    const result = await run(oneNode, (_id, rung) => {
      if (rung === 1) {
        // writes garbage in-radius but fails the gate
        return {
          steps: [
            { tool: "write", args: { path: "src/target.ts", content: "export const v = 999;\n" } },
            { done: "wrote junk" },
          ],
        };
      }
      return {
        steps: [
          { tool: "write", args: { path: "src/target.ts", content: "export const v = 1;\n" } },
          { done: "fixed" },
        ],
      };
    });
    expect(result.completed).toBe(true);
    // the garbage from rung 1 must not survive
    expect(readFileSync(join(repo, "src", "target.ts"), "utf8")).not.toContain("999");
  });

  it("halts the mission when the ladder is exhausted", async () => {
    const result = await run(oneNode, () => ({
      steps: [{ text: "giving up" }, { done: "cannot" }],
    }));
    expect(result.completed).toBe(false);
    expect(result.halted).toBe(true);
    expect(result.haltReason).toMatch(/ladder/);
    expect(result.nodes[0]!.maxRung).toBe(6); // executor, exec-repair, fallback, fallback-repair, knight, knight+diff
  });

  it("records a deterministic engine timeout from a sleeping mock attempt", async () => {
    const prev = process.env.SER_RUNG_TIMEOUT_MS;
    process.env.SER_RUNG_TIMEOUT_MS = "5";
    try {
      const result = await run(oneNode, () => ({ steps: [{ text: "starting" }, { sleepMs: 50 }, { done: "too late" }] }));
      expect(result.completed).toBe(false);
      const trace = readTrace(result.tracePath);
      const errors = trace.filter((e) => e.kind === "engine_error");
      expect(errors.length).toBeGreaterThan(0);
      expect((errors[0]!.payload as { message?: string }).message).toContain("SER_RUNG_TIMEOUT_MS=5ms");
    } finally {
      if (prev === undefined) delete process.env.SER_RUNG_TIMEOUT_MS;
      else process.env.SER_RUNG_TIMEOUT_MS = prev;
    }
  });

  it("halts honestly when a node's pack TRUNCATES at run time (over-scoped node, not DAG surgery)", async () => {
    // A node sized too coarse: its context_globs match more than its envelope holds.
    // Two large files + a tiny max_context_tokens → one is dropped → pack.truncated.
    // Commit them so the per-rung reset (git clean) doesn't wipe untracked files.
    writeFileSync(join(repo, "src", "big.ts"), "x".repeat(40_000));
    writeFileSync(join(repo, "src", "target.ts"), "x".repeat(40_000));
    await commitAll(repo, "add oversized context");
    const overscoped = `
goal: "touch the module"
budget_usd: 5
chain: cheap
nodes:
  - id: fix
    brief: "edit src/target.ts so v = 1"
    context_globs: ["src/**"]
    blast_radius: ["src/**"]
    done_check: "bash check.sh"
    budget_usd: 1
    max_context_tokens: 50
`;
    let attempts = 0;
    const result = await run(overscoped, () => {
      attempts += 1;
      return { steps: [{ done: "should never run — halted before the executor" }] };
    });
    expect(result.completed).toBe(false);
    expect(result.halted).toBe(true);
    expect(result.haltReason).toMatch(/over-scoped at run time/);
    // names the glob set to fix (which file is dropped depends on mtime, so don't pin it)
    expect(result.haltReason).toContain("src/**");
    // halted BEFORE invoking the executor — no attempt was spent
    expect(attempts).toBe(0);
    // and the halt is recorded in the trace with the context scope
    const events = readTrace(join(repo, ".squire", "trace.jsonl"));
    const stop = events.find((e) => e.kind === "budget_stop");
    expect((stop?.payload as { scope?: string } | undefined)?.scope).toBe("context");
  });

  it("parseDispute reads a substantiated push-back and rejects cry-wolf", () => {
    expect(parseDispute("tried it. DISPUTE: gate: the gate wants v=1 but the brief says v=2 — contradiction")).toEqual({
      target: "gate",
      evidence: "the gate wants v=1 but the brief says v=2 — contradiction",
    });
    expect(parseDispute("DISPUTE: brief:")).toBeNull(); // no evidence = cry-wolf, ignored
    expect(parseDispute("all tests pass, exit 0")).toBeNull();
  });

  it("attributes the halt to a DISPUTE (mis-specified task) instead of blaming the model", async () => {
    // The node never passes (gate fails) AND the builder disputes the gate every rung.
    const result = await run(oneNode, () => ({
      steps: [{ text: "I tried" }, { done: "DISPUTE: gate: the check greps for v = 1 but this brief is impossible to satisfy without breaking the shared contract" }],
    }));
    expect(result.completed).toBe(false);
    expect(result.halted).toBe(true);
    expect(result.haltReason).toMatch(/disputes its gate as mis-specified/);
    expect(result.haltReason).not.toMatch(/exhausted the escalation ladder/);
    const fails = readTrace(result.tracePath).filter((e) => e.kind === "node_fail");
    expect((fails[fails.length - 1]!.payload as { reason?: string }).reason).toBe("disputed");
  });

  it("an UPHELD dispute repairs the gate and re-runs the SAME cheap rung (no escalation)", async () => {
    // The mission's gate is wrong: it greps for v = 2, but the brief asks for v = 1.
    const wrongGate = oneNode.replace('done_check: "bash check.sh"', 'done_check: "grep -q \'v = 2\' src/target.ts"');
    const mission = parseMission(wrongGate);
    let reviewedGate = "";
    const result = await runMission({
      mission,
      chains,
      engine: new MockEngine({
        resolveScript: () => ({
          steps: [
            { tool: "write", args: { path: "src/target.ts", content: "export const v = 1;\n" } },
            { done: "wrote v=1. DISPUTE: gate: the brief asks for v = 1 but the gate greps for v = 2 — it can never pass." },
          ],
        }),
      }),
      workdir: repo,
      missionId: "dispute-fix",
      tracePath: join(repo, ".squire", "trace.jsonl"),
      now: () => ++clock,
      disputeReviewer: async ({ gate, dispute }) => {
        reviewedGate = gate;
        // Uphold: the gate is genuinely mis-specified; hand back a corrected one.
        return { upheld: dispute.target === "gate", gate: "grep -q 'v = 1' src/target.ts", reason: "gate checked v=2; brief requires v=1" };
      },
    });
    expect(reviewedGate).toContain("v = 2"); // the reviewer saw the original (wrong) gate
    expect(result.completed).toBe(true); // the repaired gate passes
    expect(result.committedNodeIds).toEqual(["fix"]);
    expect(result.nodes[0]!.maxRung).toBe(1); // re-ran on the CHEAP executor — never escalated
    const kinds = readTrace(result.tracePath).map((e) => e.kind);
    expect(kinds).toContain("dispute_review");
    expect(kinds).not.toContain("escalate");
  });

  it("RETROSPECTIVE: a cheap fail (no dispute) triggers a harness audit that fixes the brief and re-runs CHEAP", async () => {
    let attempt = 0;
    let sawBrief = "";
    const result = await runMission({
      mission: parseMission(oneNode),
      chains,
      engine: new MockEngine({
        resolveScript: () => {
          attempt += 1;
          // rung 1 + rung 2 (repair) both fail, and the agent does NOT dispute.
          if (attempt <= 2) return { steps: [{ done: "couldn't get the gate to pass" }] };
          // after the retrospective adjusts the brief, the cheap re-run succeeds.
          return { steps: [{ tool: "write", args: { path: "src/target.ts", content: "export const v = 1;\n" } }, { done: "done" }] };
        },
      }),
      workdir: repo,
      missionId: "retro",
      tracePath: join(repo, ".squire", "trace.jsonl"),
      now: () => ++clock,
      retrospectReviewer: async ({ brief }) => {
        sawBrief = brief;
        return { fault: "harness", category: "missing-hint", evidence: "brief never said to set v to the literal 1", briefAppend: "Set v to the integer 1." };
      },
    });
    expect(result.completed).toBe(true);
    expect(result.committedNodeIds).toEqual(["fix"]);
    expect(sawBrief).toContain("edit src/target.ts"); // the auditor saw the real brief
    const trace = readTrace(result.tracePath);
    const retro = trace.find((e) => e.kind === "retrospect");
    expect(retro).toBeTruthy();
    expect((retro!.payload as { fault?: string; adjusted?: boolean }).fault).toBe("harness");
    expect((retro!.payload as { adjusted?: boolean }).adjusted).toBe(true);
    // it FIXED the task and re-ran the cheap executor — never escalated to the fallback model.
    const models = trace.filter((e) => e.kind === "node_start").map((e) => (e.payload as { model?: string }).model);
    expect(models).not.toContain("deepseek/deepseek-chat");
  });

  it("RETROSPECTIVE GUARDRAIL: a suspected gate problem is NOT weakened here — it routes through the audited dispute path", async () => {
    // gate greps v=2 but brief wants v=1; the agent writes v=1, never disputes, fails twice.
    const wrongGate = oneNode.replace('done_check: "bash check.sh"', 'done_check: "grep -q \'v = 2\' src/target.ts"');
    let disputeCalled = false;
    const result = await runMission({
      mission: parseMission(wrongGate),
      chains,
      engine: new MockEngine({
        resolveScript: () => ({ steps: [{ tool: "write", args: { path: "src/target.ts", content: "export const v = 1;\n" } }, { done: "wrote v=1" }] }),
      }),
      workdir: repo,
      missionId: "retro-gate",
      tracePath: join(repo, ".squire", "trace.jsonl"),
      now: () => ++clock,
      // retrospect flags the gate but proposes NO brief change — it must not touch the gate itself.
      retrospectReviewer: async () => ({ fault: "harness", category: "gate-unsatisfiable", evidence: "gate greps v=2, brief wants v=1", gateProblem: "the gate greps for v = 2 but the brief requires v = 1" }),
      disputeReviewer: async ({ dispute }) => {
        disputeCalled = true;
        return { upheld: dispute.target === "gate", gate: "grep -q 'v = 1' src/target.ts", reason: "gate checked the wrong value" };
      },
    });
    expect(disputeCalled).toBe(true); // the gate concern was routed to the AUDITED reviewer, not applied directly
    expect(result.completed).toBe(true); // which repaired it to a still-objective gate, and the node passed
    const kinds = readTrace(result.tracePath).map((e) => e.kind);
    expect(kinds).toContain("retrospect");
    expect(kinds).toContain("dispute_review");
  });

  it("a dispute is CLEARED when a stronger rung simply does the task (no cry-wolf halt)", async () => {
    const result = await run(oneNode, (_id, rung) => {
      if (rung === 1) return { steps: [{ done: "DISPUTE: gate: I think this is contradictory and cannot be done" }] };
      // a later rung just does it — the dispute was the weak model's excuse
      return {
        steps: [
          { tool: "edit", args: { path: "src/target.ts", oldString: "v = 0", newString: "v = 1" } },
          { tool: "bash", args: { command: "bash check.sh" } },
          { done: "actually it was fine, fixed it" },
        ],
      };
    });
    expect(result.completed).toBe(true); // the dispute did NOT halt — a stronger rung overruled it
    expect(result.committedNodeIds).toEqual(["fix"]);
  });

  it("counts a blast-radius denial without persisting the out-of-radius write", async () => {
    const result = await run(oneNode, (_id, rung) => {
      if (rung >= 2) {
        return {
          steps: [
            { tool: "edit", args: { path: "src/target.ts", oldString: "v = 0", newString: "v = 1" } },
            { tool: "bash", args: { command: "bash check.sh" } },
            { done: "ok" },
          ],
        };
      }
      return {
        steps: [
          { tool: "write", args: { path: "outside/evil.ts", content: "leak" } },
          { done: "tried to escape" },
        ],
      };
    });
    expect(result.nodes[0]!.blastDenied).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(repo, "outside", "evil.ts"))).toBe(false);
    expect(result.completed).toBe(true);
  });

  it("halts immediately when the global budget cap is exceeded", async () => {
    const tight = oneNode.replace("budget_usd: 5", "budget_usd: 0.001");
    const result = await run(tight, () => ({
      steps: [
        { usage: { in: 1_000_000, out: 1_000_000 } },
        { tool: "edit", args: { path: "src/target.ts", oldString: "v = 0", newString: "v = 1" } },
        { done: "done" },
      ],
    }));
    expect(result.halted).toBe(true);
    expect(result.haltReason).toMatch(/budget/);
    const kinds = readTrace(result.tracePath).map((e) => e.kind);
    expect(kinds).toContain("budget_stop");
  });

  it("commits a node whose gate PASSED even if it ran over its per-node budget", async () => {
    // Per-node cap is tiny ($0.0001); global cap is generous ($5). The attempt
    // spends ~$0.001 (over the node cap, under the global cap) AND passes the gate.
    const tinyNodeBudget = oneNode.replace("budget_usd: 1", "budget_usd: 0.0001");
    const result = await run(tinyNodeBudget, () => ({
      steps: [
        { usage: { in: 1000, out: 1000 } }, // ~$0.001 > $0.0001 node cap
        { tool: "edit", args: { path: "src/target.ts", oldString: "v = 0", newString: "v = 1" } },
        { tool: "bash", args: { command: "bash check.sh" } },
        { done: "fixed v despite the tiny node budget" },
      ],
    }));
    // The verified work commits; the mission completes (NOT halted, NOT failed).
    expect(result.completed).toBe(true);
    expect(result.committedNodeIds).toEqual(["fix"]);
    expect(result.halted).toBe(false);
    // The over-budget commit is recorded as a WARNING on node_pass, not a failure.
    const events = readTrace(result.tracePath);
    const pass = events.find((e) => e.kind === "node_pass");
    expect(pass).toBeDefined();
    expect((pass!.payload as { over_budget_committed?: boolean }).over_budget_committed).toBe(true);
    // It did NOT escalate (the work was done on the first attempt) and never node-failed.
    expect(events.some((e) => e.kind === "node_fail")).toBe(false);
    expect(result.nodes[0]!.maxRung).toBe(1);
  });

  it("commits verified work when the gate passes even if the engine reports an error afterward", async () => {
    const result = await run(oneNode, () => ({
      steps: [
        { tool: "edit", args: { path: "src/target.ts", oldString: "v = 0", newString: "v = 1" } },
        { error: "provider ended after tool call" },
      ],
    }));

    expect(result.completed).toBe(true);
    expect(result.committedNodeIds).toEqual(["fix"]);
    expect(readFileSync(join(repo, "src", "target.ts"), "utf8")).toContain("v = 1");
    const kinds = readTrace(result.tracePath).map((e) => e.kind);
    expect(kinds).toContain("engine_error");
    expect(kinds).toContain("node_pass");
    expect(kinds).not.toContain("node_fail");
  });

  it("packs existing literal blast-radius files even when context_globs omits them", async () => {
    const omittedContext = `
goal: "inspect existing target"
budget_usd: 5
chain: cheap
nodes:
  - id: inspect
    brief: "inspect src/target.ts"
    context_globs: []
    blast_radius: ["src/target.ts"]
    done_check: "true"
    budget_usd: 1
`;
    const result = await run(omittedContext, () => ({
      steps: [{ done: "no change needed" }],
    }));

    expect(result.completed).toBe(true);
    const pack = readTrace(result.tracePath).find((e) => e.kind === "pack");
    expect((pack!.payload as { files: string[] }).files).toContain("src/target.ts");
  });

  it("budget_scale multiplies the effective caps (frontier baseline sizing)", async () => {
    // Same tiny-budget node + ~$0.001 spend, but a chain with budget_scale:100
    // lifts the per-node cap to $0.01 — so it is NOT over budget and commits clean.
    const scaledChains = parseChains(`
chains:
  cheap:
    executor: "qwen/qwen3-coder"
    fallback: "qwen/qwen3-coder"
    knight: "qwen/qwen3-coder"
    budget_scale: 100
prices:
  "qwen/qwen3-coder": { in: 0.2, out: 0.8 }
`);
    const mission = parseMission(oneNode.replace("budget_usd: 1", "budget_usd: 0.0001"));
    const result = await runMission({
      mission,
      chains: scaledChains,
      engine: new MockEngine({
        resolveScript: () => ({
          steps: [
            { usage: { in: 1000, out: 1000 } }, // ~$0.001, under the scaled $0.01 cap
            { tool: "edit", args: { path: "src/target.ts", oldString: "v = 0", newString: "v = 1" } },
            { tool: "bash", args: { command: "bash check.sh" } },
            { done: "fixed" },
          ],
        }),
      }),
      workdir: repo,
      missionId: "scaled",
      tracePath: join(repo, ".squire", "trace.jsonl"),
      now: () => ++clock,
    });
    expect(result.completed).toBe(true);
    const pass = readTrace(result.tracePath).find((e) => e.kind === "node_pass");
    expect((pass!.payload as { over_budget_committed?: boolean })?.over_budget_committed).toBeUndefined();
  });

  it("stops escalating a FAILING node once it has burned its per-node budget", async () => {
    // Tiny node budget, gate never passes — should fail FAST without climbing all
    // four rungs (the per-node cap guards starting another attempt).
    const tinyNodeBudget = oneNode.replace("budget_usd: 1", "budget_usd: 0.0001");
    const result = await run(tinyNodeBudget, () => ({
      steps: [
        { usage: { in: 1000, out: 1000 } }, // over the node cap
        { text: "did nothing useful" },
        { done: "gave up" },
      ],
    }));
    expect(result.completed).toBe(false);
    expect(result.halted).toBe(true);
    // Failed at rung 1 — it did NOT spend three more rungs over budget.
    expect(result.nodes[0]!.maxRung).toBe(1);
    const fails = readTrace(result.tracePath).filter((e) => e.kind === "node_fail");
    expect(fails).toHaveLength(1);
    expect((fails[0]!.payload as { reason?: string }).reason).toBe("node_budget");
  });
});
