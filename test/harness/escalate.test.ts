import { describe, it, expect } from "vitest";
import { ladder, buildFailureContext, MAX_RUNGS } from "../../src/harness/escalate.js";

const chain = {
  executor: "qwen/qwen3-coder",
  fallback: "deepseek/deepseek-chat",
  knight: "anthropic/claude-opus-4",
  harness: "on" as const,
  budget_scale: 1,
  node_context_budget: 40000,
};

describe("ladder", () => {
  it("interleaves a same-model REPAIR rung before each escalation (SPEC §9)", () => {
    const rungs = ladder(chain);
    expect(rungs).toHaveLength(MAX_RUNGS);
    // executor, executor-repair, fallback, fallback-repair, knight, knight+diff
    expect(rungs.map((r) => r.model)).toEqual([
      "qwen/qwen3-coder",
      "qwen/qwen3-coder",
      "deepseek/deepseek-chat",
      "deepseek/deepseek-chat",
      "anthropic/claude-opus-4",
      "anthropic/claude-opus-4",
    ]);
    // a repair rung re-runs the SAME model on its own failed attempt, with failure context
    expect(rungs.map((r) => r.repair ?? false)).toEqual([false, true, false, true, false, false]);
    expect(rungs[0]!.addFailureContext).toBe(false);
    expect(rungs[1]!.addFailureContext).toBe(true); // the repair rung needs the gate error to fix it
    expect(rungs[5]!.addPriorDiff).toBe(true);
    expect(rungs[4]!.addPriorDiff).toBe(false);
  });

  it("a repair rung always pairs with the model it repairs (no cross-model repair)", () => {
    for (const r of ladder(chain).filter((x) => x.repair)) {
      // repair rungs carry failure context (you can't fix what you can't see)
      expect(r.addFailureContext).toBe(true);
    }
  });
});

describe("buildFailureContext", () => {
  it("renders a structured block with gate facts and violations", () => {
    const block = buildFailureContext({
      gateCommand: "pnpm test",
      exitCode: 1,
      timedOut: false,
      stdoutTail: "",
      stderrTail: "AssertionError: expected 1 to be 2",
      reconcileViolations: ['changed file "x.ts" is outside blast_radius'],
      confabulation: true,
      changedFiles: ["src/a.ts"],
    });
    expect(block).toContain("FAILURE CONTEXT");
    expect(block).toContain("pnpm test");
    expect(block).toContain("exit code: 1");
    expect(block).toContain("AssertionError");
    expect(block).toContain("outside blast_radius");
    expect(block).toContain("claimed a check ran");
    expect(block).toContain("src/a.ts");
  });

  it("surfaces the gate STDOUT as the diagnostic — the worker can SEE what the check rejected", () => {
    // The secure-storage failure: a grep gate is silent on stderr; the plaintext value it
    // rejected is on stdout. Without this, qwen failed identically 4× because it was blind.
    const block = buildFailureContext({
      gateCommand: "sqlite3 app.db 'SELECT api_keys' | grep -v key_",
      exitCode: 1,
      timedOut: false,
      stdoutTail: '{"vouchflow":"vouchflow_key_123"}',
      stderrTail: "",
      reconcileViolations: [],
      confabulation: false,
      changedFiles: ["storage.js"],
    });
    expect(block).toContain("gate output (stdout tail)");
    expect(block).toContain("THE DIAGNOSTIC");
    expect(block).toContain("vouchflow_key_123"); // the worker now sees the plaintext leak
  });

  it("includes the prior diff only when provided", () => {
    const withDiff = buildFailureContext({
      gateCommand: "true",
      exitCode: 1,
      timedOut: false,
      stdoutTail: "",
      stderrTail: "",
      reconcileViolations: [],
      confabulation: false,
      changedFiles: [],
      priorDiff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2",
    });
    expect(withDiff).toContain("previous attempt diff");
    expect(withDiff).toContain("+2");
  });

  it("BOUNDS a huge prior diff so the request payload can't blow the provider cap (the web-app 413)", () => {
    const huge = "+x".repeat(20_000); // ~40k chars, well over the cap
    const block = buildFailureContext({
      gateCommand: "true",
      exitCode: 1,
      timedOut: false,
      stdoutTail: "",
      stderrTail: "",
      reconcileViolations: [],
      confabulation: false,
      changedFiles: [],
      priorDiff: huge,
    });
    expect(block.length).toBeLessThan(16_000);
    expect(block).toContain("chars of diff omitted to bound the request payload");
  });
});

describe("boundDiff", () => {
  it("passes a small diff through unchanged", async () => {
    const { boundDiff } = await import("../../src/harness/escalate.js");
    const d = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2";
    expect(boundDiff(d)).toBe(d);
  });

  it("keeps head and tail of an oversized diff with a marker", async () => {
    const { boundDiff } = await import("../../src/harness/escalate.js");
    const d = "HEAD_MARKER" + "z".repeat(30_000) + "TAIL_MARKER";
    const out = boundDiff(d);
    expect(out.length).toBeLessThan(d.length);
    expect(out.startsWith("HEAD_MARKER")).toBe(true);
    expect(out.endsWith("TAIL_MARKER")).toBe(true);
    expect(out).toContain("chars of diff omitted");
  });
});
