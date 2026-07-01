import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateLoopCase,
  evaluateLoopSuite,
  loadLoopEvalSuite,
  renderLoopEvalReport,
  type CommandResult,
  type LoopEvalDriver,
} from "../../src/eval/loop.js";

const ROOT = resolve(__dirname, "..", "..");

class FakeDriver implements LoopEvalDriver {
  constructor(private readonly statusResult: CommandResult, private readonly continueResult: CommandResult) {}

  async status(): Promise<CommandResult> {
    return this.statusResult;
  }

  async continue(): Promise<CommandResult> {
    return this.continueResult;
  }
}

describe("SER loop eval harness", () => {
  it("loads the default product-loop suite", () => {
    const suite = loadLoopEvalSuite(join(ROOT, "eval", "ser-loop", "cases.yaml"));
    expect(suite.version).toBe(1);
    expect(suite.cases.length).toBeGreaterThanOrEqual(4);
    expect(suite.cases.map((c) => c.id)).toContain("continue-during-build");
  });

  it("scores clean status and argument-free continue as passing", async () => {
    const suite = loadLoopEvalSuite(join(ROOT, "eval", "ser-loop", "cases.yaml"));
    const testCase = suite.cases[0]!;
    const root = mkdtempSync(join(tmpdir(), "ser-loop-eval-pass-"));
    const result = await evaluateLoopCase(testCase, root, new FakeDriver(
      {
        exitCode: 0,
        stdout: [
          "Goal: Build a simple offline todo list app, no accounts",
          "State: complete",
          "Now: The spec is buildable.",
          "Next: Continue the verified build loop.",
        ].join("\n"),
        stderr: "",
      },
      { exitCode: 0, stdout: "No work needed; session is ready.\n", stderr: "" },
    ));

    expect(result.passed).toBe(true);
    expect(result.metrics.resumeSuccess).toBe(true);
    expect(result.metrics.manualArgCountAfterStart).toBe(0);
  });

  it("flags trace leakage and manual resume instructions", async () => {
    const suite = loadLoopEvalSuite(join(ROOT, "eval", "ser-loop", "cases.yaml"));
    const testCase = suite.cases[0]!;
    const root = mkdtempSync(join(tmpdir(), "ser-loop-eval-fail-"));
    const result = await evaluateLoopCase(testCase, root, new FakeDriver(
      {
        exitCode: 0,
        stdout: [
          "Goal: Build a simple offline todo list app, no accounts",
          "State: complete",
          "trace: /tmp/app/.squire/trace-run.jsonl",
        ].join("\n"),
        stderr: "",
      },
      { exitCode: 1, stdout: "", stderr: "pass --spec .ser/spec.yaml --workdir app\n" },
    ));

    expect(result.passed).toBe(false);
    expect(result.metrics.resumeSuccess).toBe(false);
    expect(result.metrics.manualArgCountAfterStart).toBe(1);
    expect(result.assertions.some((a) => !a.passed && a.name.includes("status omits"))).toBe(true);
  });

  it("aggregates suite-level target metrics", async () => {
    const suite = loadLoopEvalSuite(join(ROOT, "eval", "ser-loop", "cases.yaml"));
    const report = await evaluateLoopSuite(
      { ...suite, cases: suite.cases.slice(0, 2) },
      (testCase) => mkdtempSync(join(tmpdir(), `ser-loop-eval-${testCase.id}-`)),
      new FakeDriver(
        {
          exitCode: 0,
          stdout: "Goal: x\nState: complete\nNow: ok\nNext: continue\n",
          stderr: "",
        },
        { exitCode: 0, stdout: "continued\n", stderr: "" },
      ),
    );

    expect(report.score.total).toBe(2);
    expect(report.score.resumeSuccessRate).toBe(1);
    expect(renderLoopEvalReport(report)).toContain("SER loop eval");
  });
});
