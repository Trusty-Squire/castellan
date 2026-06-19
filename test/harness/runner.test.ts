import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXECUTOR_SYSTEM_PROMPT, runMission } from "../../src/harness/runner.js";
import { MockEngine, type ScriptResolver } from "../../src/engine/mock.js";
import { initRepo } from "../../src/harness/checkpoint.js";
import { parseMission, parseChains } from "../../src/contract/schema.js";
import { readTrace } from "../../src/harness/trace.js";

const chains = parseChains(`
chains:
  cheap:
    executor: "qwen/qwen3-coder"
    fallback: "deepseek/deepseek-chat"
    knight: "anthropic/claude-opus-4"
prices:
  "qwen/qwen3-coder": { in: 0.2, out: 0.8 }
  "deepseek/deepseek-chat": { in: 0.14, out: 0.28 }
  "anthropic/claude-opus-4": { in: 15.0, out: 75.0 }
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

describe("runMission", () => {
  it("tells executors to write literal CommonJS source for JS files", () => {
    expect(EXECUTOR_SYSTEM_PROMPT).toContain("content argument is the exact file body");
    expect(EXECUTOR_SYSTEM_PROMPT).toContain("module.exports");
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

  it("escalates when rung 1 fails the gate, then passes on rung 2", async () => {
    const result = await run(oneNode, (_id, rung) => {
      if (rung === 1) {
        // does nothing useful — gate will fail
        return { steps: [{ text: "I think it's fine" }, { done: "all good" }] };
      }
      return {
        steps: [
          { tool: "edit", args: { path: "src/target.ts", oldString: "v = 0", newString: "v = 1" } },
          { tool: "bash", args: { command: "bash check.sh" } },
          { done: "fixed on retry" },
        ],
      };
    });
    expect(result.completed).toBe(true);
    const node = result.nodes[0]!;
    expect(node.maxRung).toBe(2);
    const kinds = readTrace(result.tracePath).map((e) => e.kind);
    expect(kinds).toContain("node_fail");
    expect(kinds).toContain("escalate");
    expect(kinds).toContain("reset");
  });

  it("runs a fresh targeted repair agent before escalating a failed gate", async () => {
    const result = await run(oneNode, (id) => {
      if (id === "fix:repair1") {
        return {
          steps: [
            { tool: "edit", args: { path: "src/target.ts", oldString: "v = 0", newString: "v = 1" } },
            { tool: "bash", args: { command: "bash check.sh" } },
            { done: "small repair passed the gate" },
          ],
        };
      }
      return {
        steps: [
          { text: "missed the exact assertion" },
          { done: "looks okay" },
        ],
      };
    });
    expect(result.completed).toBe(true);
    expect(result.nodes[0]!.maxRung).toBe(1);
    const kinds = readTrace(result.tracePath).map((e) => e.kind);
    expect(kinds).toContain("repair_start");
    expect(kinds).not.toContain("escalate");
    expect(readFileSync(join(repo, "src", "target.ts"), "utf8")).toContain("v = 1");
  });

  it("escalates after targeted repairs are exhausted", async () => {
    const result = await run(oneNode, (_id, rung) => {
      if (rung === 1) return { steps: [{ done: "still wrong" }] };
      return {
        steps: [
          { tool: "edit", args: { path: "src/target.ts", oldString: "v = 0", newString: "v = 1" } },
          { done: "fixed on rung 2" },
        ],
      };
    });
    expect(result.completed).toBe(true);
    expect(result.nodes[0]!.maxRung).toBe(2);
    const kinds = readTrace(result.tracePath).map((e) => e.kind);
    expect(kinds.filter((kind) => kind === "repair_start")).toHaveLength(2);
    expect(kinds).toContain("escalate");
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
    expect(result.nodes[0]!.maxRung).toBe(4);
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
