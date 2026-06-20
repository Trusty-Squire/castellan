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
  it("produces the 4-rung escalation plan per SPEC §9", () => {
    const rungs = ladder(chain);
    expect(rungs).toHaveLength(MAX_RUNGS);
    expect(rungs.map((r) => r.model)).toEqual([
      "qwen/qwen3-coder",
      "deepseek/deepseek-chat",
      "anthropic/claude-opus-4",
      "anthropic/claude-opus-4",
    ]);
    expect(rungs[0]!.addFailureContext).toBe(false);
    expect(rungs[1]!.addFailureContext).toBe(true);
    expect(rungs[3]!.addPriorDiff).toBe(true);
    expect(rungs[2]!.addPriorDiff).toBe(false);
  });
});

describe("buildFailureContext", () => {
  it("renders a structured block with gate facts and violations", () => {
    const block = buildFailureContext({
      gateCommand: "pnpm test",
      exitCode: 1,
      timedOut: false,
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

  it("includes the prior diff only when provided", () => {
    const withDiff = buildFailureContext({
      gateCommand: "true",
      exitCode: 1,
      timedOut: false,
      stderrTail: "",
      reconcileViolations: [],
      confabulation: false,
      changedFiles: [],
      priorDiff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2",
    });
    expect(withDiff).toContain("previous attempt diff");
    expect(withDiff).toContain("+2");
  });
});
