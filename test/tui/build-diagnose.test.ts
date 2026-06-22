import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMission } from "../../src/harness/runner.js";
import { MockEngine } from "../../src/engine/mock.js";
import { initRepo } from "../../src/harness/checkpoint.js";
import { parseMission, parseChains } from "../../src/contract/schema.js";
import { readHaltFacts, investigateHalt, type HaltFacts } from "../../src/tui/diagnose.js";
import { newProgressState, renderTraceLine } from "../../src/tui/progress.js";
import type { TraceEvent } from "../../src/harness/trace.js";
import { makeStyler } from "../../src/style.js";
import type { LlmClient } from "../../src/llm/types.js";

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

const HALT_MISSION = `
goal: "write OK to report"
budget_usd: 5
chain: cheap
nodes:
  - id: report
    brief: "write the word OK to src/report.txt"
    blast_radius: ["src/**"]
    done_check: "grep -q OK src/report.txt"
    budget_usd: 1
`;

describe("honest-halt diagnosis (readHaltFacts over a real halted trace)", () => {
  let repo: string;
  let clock: number;
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "squire-halt-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    await initRepo(repo);
    clock = 0;
  });

  async function runHalt() {
    const mission = parseMission(HALT_MISSION);
    const tracePath = join(repo, ".squire", "trace.jsonl");
    // Every rung writes the WRONG content, so `grep -q OK` fails all four rungs.
    const result = await runMission({
      mission,
      chains,
      engine: new MockEngine({
        resolveScript: () => ({
          steps: [
            { tool: "write", args: { path: "src/report.txt", content: "NOPE\n" } },
            { tool: "bash", args: { command: "grep -q OK src/report.txt" } },
            { usage: { in: 100, out: 50 } },
            { done: "wrote report" },
          ],
        }),
      }),
      workdir: repo,
      missionId: "m-halt",
      tracePath,
      now: () => ++clock,
    });
    return { result, tracePath };
  }

  it("runs the ladder to exhaustion and halts honestly", async () => {
    const { result } = await runHalt();
    expect(result.completed).toBe(false);
    expect(result.haltReason).toMatch(/exhausted the escalation ladder/);
  });

  it("extracts the failing piece, its check, exit code, and ladder depth", async () => {
    const { result, tracePath } = await runHalt();
    const facts = readHaltFacts(tracePath, [`MISSION HALTED — ${result.haltReason}`]);
    expect(facts.failingNodeId).toBe("report");
    expect(facts.gateCommand).toBe("grep -q OK src/report.txt");
    expect(facts.gateExitCode).toBe(1);
    expect(facts.maxRung).toBe(6); // ladder now interleaves a same-model repair rung before each escalation
    expect(facts.confabulation).toBe(false);
    expect(facts.haltReason).toMatch(/exhausted the escalation ladder/);
  });

  it("falls back to the stdout HALT line when the trace is unreadable", () => {
    const facts = readHaltFacts(join(repo, "does-not-exist.jsonl"), [
      'MISSION HALTED — node "report" exhausted the escalation ladder',
    ]);
    expect(facts.haltReason).toMatch(/exhausted the escalation ladder/);
    expect(facts.failingNodeId).toBeUndefined();
  });
});

describe("investigateHalt (premium diagnosis, parsed + safe-defaulted)", () => {
  const facts: HaltFacts = {
    haltReason: "x",
    failingNodeId: "report",
    gateCommand: "grep -q OK src/report.txt",
    gateExitCode: 1,
    timedOut: false,
    reconcileViolations: [],
    confabulation: false,
    maxRung: 4,
  };

  it("returns a safe default when the model call throws", async () => {
    const dead: LlmClient = { complete: async () => { throw new Error("boom"); } };
    const dx = await investigateHalt(facts, "write OK", "grep -q OK src/report.txt", dead, "m");
    expect(dx.cause).toBe("bad_check");
    expect(dx.owner).toBe("ser");
    expect(dx.explanation).toBe("");
  });

  it("parses a model verdict (gate is ser's to fix)", async () => {
    const stub: LlmClient = {
      complete: async () => ({
        text: JSON.stringify({
          cause: "bad_check",
          explanation: "the check looked for a word the brief never required",
          check_verdict: "unfair — it grepped for OK but the brief never asked for that literal",
          remedy: "verify the file exists instead",
          owner: "ser",
          corrected_check: "test -f src/report.txt",
          spec_change: "",
        }),
        inTokens: 1,
        outTokens: 1,
      }),
    };
    const dx = await investigateHalt(facts, "write a report", "grep -q OK src/report.txt", stub, "m");
    expect(dx.cause).toBe("bad_check");
    expect(dx.owner).toBe("ser");
    expect(dx.corrected_check).toBe("test -f src/report.txt");
  });
});

describe("build progress renderer (pure, append-only milestones)", () => {
  const s = makeStyler(false); // no color → plain string assertions
  const mk = (kind: TraceEvent["kind"], nodeId?: string, payload?: unknown): TraceEvent =>
    ({ ts: 0, missionId: "m", nodeId, kind, payload: payload ?? null, costUsdSoFar: 0 });

  it("maps events to piece/check/escalate/pass lines and drops raw chatter", () => {
    const st = newProgressState(2);
    const events: TraceEvent[] = [
      mk("mission_start"),
      mk("node_start", "a"),
      mk("tool_call", "a", { name: "bash" }), // chatter → null
      mk("pack", "a"),
      mk("gate", "a"),
      mk("node_pass", "a"),
      mk("node_start", "b"),
      mk("gate", "b"),
      mk("node_fail", "b"), // mid-ladder fail → suppressed
      mk("escalate", "b", { nextModel: "anthropic/claude-opus-4" }),
      mk("node_pass", "b"),
    ];
    const lines = events.map((e) => renderTraceLine(e, st, s)).filter((l): l is string => l !== null);
    expect(lines).toEqual([
      "  ▸ piece 1/2 — a",
      "  · checking a",
      "  ✓ piece 1/2 — a",
      "  ▸ piece 2/2 — b",
      "  · checking b",
      "  ↑ piece 2 — retrying with opus-4",
      "  ✓ piece 2/2 — b",
    ]);
    expect(lines.some((l) => /tool|pack|node_fail/.test(l))).toBe(false);
  });

  it("skips synthetic raw-mode nodes and shows k/? until N is known", () => {
    const st = newProgressState(null);
    expect(renderTraceLine(mk("node_start", "(raw)"), st, s)).toBeNull();
    expect(renderTraceLine(mk("node_start", "x"), st, s)).toBe("  ▸ piece 1 — x");
    expect(renderTraceLine(mk("node_pass", "x"), st, s)).toBe("  ✓ piece 1 — x");
  });
});
