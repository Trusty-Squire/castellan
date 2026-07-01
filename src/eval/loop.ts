import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { parse } from "yaml";
import { writeSession, type SerSession } from "../session.js";

const AssertionSchema = z.object({
  statusContains: z.array(z.string()).default([]),
  statusNotContains: z.array(z.string()).default([]),
  continueRequiresArgs: z.boolean().optional(),
  continueExitCode: z.number().optional(),
  maxHumanTurns: z.number().int().nonnegative().optional(),
  humanNeeded: z.boolean().optional(),
});

export const LoopEvalCaseSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  goal: z.string(),
  interruption: z.enum([
    "after_spec",
    "during_build",
    "after_gate_failure",
    "after_visual_block",
    "after_crash",
    "honest_blocker",
    "after_ship",
  ]),
  seedSession: z.object({
    phase: z.enum(["spec", "build", "audit", "ship"]).default("spec"),
    state: z.enum(["working", "blocked", "complete"]).default("working"),
    summary: z.string(),
    next: z.string().optional(),
    specStatus: z.enum(["drafting", "locked", "needs_input"]).optional(),
    currentLoop: z.string().optional(),
    lastAttempt: z.string().optional(),
    lastVerifier: z.string().optional(),
    lastResult: z.string().optional(),
    failureClass: z.enum([
      "clarification_needed",
      "localization_context",
      "runner_environment",
      "patch_application",
      "regression_gate",
      "oracle_false_positive",
      "provider_timeout",
      "verifier_unavailable",
      "model_capability",
    ]).optional(),
    nextMutation: z.string().optional(),
    humanNeeded: z.boolean().optional(),
    blocker: z.string().optional(),
    specPath: z.string().optional(),
    workdir: z.string().optional(),
    latestTrace: z.string().optional(),
  }),
  expect: AssertionSchema.default({}),
});

export const LoopEvalSuiteSchema = z.object({
  version: z.literal(1),
  targets: z.object({
    falseShipRate: z.number().default(0),
    resumeSuccessRate: z.number().default(0.8),
    blockerAccuracy: z.number().default(0.8),
    manualArgCountAfterStart: z.number().default(0),
    maxHumanTurnsPerShip: z.number().default(2),
  }).default({}),
  cases: z.array(LoopEvalCaseSchema),
});

export type LoopEvalCase = z.infer<typeof LoopEvalCaseSchema>;
export type LoopEvalSuite = z.infer<typeof LoopEvalSuiteSchema>;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LoopEvalDriver {
  status(cwd: string): Promise<CommandResult>;
  continue(cwd: string): Promise<CommandResult>;
}

export interface LoopAssertionResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface LoopCaseResult {
  id: string;
  passed: boolean;
  interruption: LoopEvalCase["interruption"];
  assertions: LoopAssertionResult[];
  metrics: {
    resumeSuccess: boolean;
    manualArgCountAfterStart: number;
    humanTurns: number;
    falseShip: boolean;
    blockerClassified: boolean | null;
  };
  status: CommandResult;
  continued: CommandResult;
}

export interface LoopEvalReport {
  cases: LoopCaseResult[];
  score: {
    passed: number;
    total: number;
    resumeSuccessRate: number;
    blockerAccuracy: number;
    falseShipRate: number;
    manualArgCountAfterStart: number;
    humanTurnsPerShip: number;
  };
  targetPassed: boolean;
}

export function loadLoopEvalSuite(path: string): LoopEvalSuite {
  const raw = readFileSync(path, "utf8");
  return LoopEvalSuiteSchema.parse(parse(raw));
}

export function seedLoopEvalCase(root: string, testCase: LoopEvalCase): void {
  mkdirSync(root, { recursive: true });
  const workdir = testCase.seedSession.workdir ? resolve(root, testCase.seedSession.workdir) : root;
  mkdirSync(workdir, { recursive: true });
  const specPath = testCase.seedSession.specPath ? resolve(root, testCase.seedSession.specPath) : undefined;
  if (specPath) {
    mkdirSync(dirname(specPath), { recursive: true });
    if (!existsSync(specPath)) writeFileSync(specPath, "thesis: placeholder\nrequirements: []\n");
  }
  const session: Omit<SerSession, "updatedAt"> = {
    goal: testCase.goal,
    phase: testCase.seedSession.phase,
    state: testCase.seedSession.state,
    summary: testCase.seedSession.summary,
    next: testCase.seedSession.next,
    specStatus: testCase.seedSession.specStatus,
    currentLoop: testCase.seedSession.currentLoop,
    lastAttempt: testCase.seedSession.lastAttempt,
    lastVerifier: testCase.seedSession.lastVerifier,
    lastResult: testCase.seedSession.lastResult,
    failureClass: testCase.seedSession.failureClass,
    nextMutation: testCase.seedSession.nextMutation,
    humanNeeded: testCase.seedSession.humanNeeded,
    blocker: testCase.seedSession.blocker,
    workdir,
    specPath,
    latestTrace: testCase.seedSession.latestTrace ? resolve(root, testCase.seedSession.latestTrace) : undefined,
  };
  writeSession(session, root);
}

export async function evaluateLoopCase(testCase: LoopEvalCase, root: string, driver: LoopEvalDriver): Promise<LoopCaseResult> {
  seedLoopEvalCase(root, testCase);
  const status = await driver.status(root);
  const continued = await driver.continue(root);
  const assertions: LoopAssertionResult[] = [];
  const expect = testCase.expect;

  for (const needle of expect.statusContains) {
    assertions.push({
      name: `status contains ${needle}`,
      passed: status.stdout.includes(needle),
      detail: status.stdout,
    });
  }
  for (const needle of expect.statusNotContains) {
    assertions.push({
      name: `status omits ${needle}`,
      passed: !status.stdout.toLowerCase().includes(needle.toLowerCase()),
      detail: status.stdout,
    });
  }

  const manualArgCountAfterStart = /\b(--spec|--workdir|trace-[\w.-]+\.jsonl|\.squire\/)/.test(status.stdout + continued.stdout + continued.stderr) ? 1 : 0;
  const resumeSuccess = continued.exitCode === (expect.continueExitCode ?? 0);
  if (typeof expect.continueRequiresArgs === "boolean") {
    assertions.push({
      name: "continue requires no manual args",
      passed: expect.continueRequiresArgs ? manualArgCountAfterStart > 0 : manualArgCountAfterStart === 0,
      detail: continued.stdout + continued.stderr,
    });
  }
  if (typeof expect.continueExitCode === "number") {
    assertions.push({
      name: `continue exits ${expect.continueExitCode}`,
      passed: continued.exitCode === expect.continueExitCode,
      detail: continued.stdout + continued.stderr,
    });
  }

  const humanTurns = /human needed:\s*yes|needs a call from you|press enter|approve\?|type your own|human gate/i.test(status.stdout + continued.stdout + continued.stderr) ? 1 : 0;
  if (typeof expect.maxHumanTurns === "number") {
    assertions.push({
      name: `human turns <= ${expect.maxHumanTurns}`,
      passed: humanTurns <= expect.maxHumanTurns,
      detail: `${humanTurns}`,
    });
  }
  if (typeof expect.humanNeeded === "boolean") {
    assertions.push({
      name: `human needed is ${expect.humanNeeded}`,
      passed: expect.humanNeeded ? humanTurns > 0 : humanTurns === 0,
      detail: status.stdout + continued.stdout + continued.stderr,
    });
  }

  const falseShip = /✓ shipped|MISSION COMPLETE/i.test(continued.stdout) && testCase.seedSession.state === "blocked";
  const blockerClassified = testCase.seedSession.state === "blocked"
    ? /blocked|refused|missing|unavailable|cannot|needs|halt/i.test(status.stdout + continued.stdout + continued.stderr)
    : null;

  assertions.push({
    name: "does not falsely ship blocked state",
    passed: !falseShip,
    detail: continued.stdout,
  });

  return {
    id: testCase.id,
    interruption: testCase.interruption,
    passed: assertions.every((a) => a.passed),
    assertions,
    metrics: {
      resumeSuccess,
      manualArgCountAfterStart,
      humanTurns,
      falseShip,
      blockerClassified,
    },
    status,
    continued,
  };
}

export async function evaluateLoopSuite(suite: LoopEvalSuite, makeRoot: (testCase: LoopEvalCase) => string, driver: LoopEvalDriver): Promise<LoopEvalReport> {
  const cases: LoopCaseResult[] = [];
  for (const testCase of suite.cases) {
    cases.push(await evaluateLoopCase(testCase, makeRoot(testCase), driver));
  }
  const total = cases.length;
  const passed = cases.filter((c) => c.passed).length;
  const blockers = cases.filter((c) => c.metrics.blockerClassified !== null);
  const shipped = cases.filter((c) => c.interruption === "after_ship");
  const score = {
    passed,
    total,
    resumeSuccessRate: total ? cases.filter((c) => c.metrics.resumeSuccess).length / total : 0,
    blockerAccuracy: blockers.length ? blockers.filter((c) => c.metrics.blockerClassified).length / blockers.length : 1,
    falseShipRate: total ? cases.filter((c) => c.metrics.falseShip).length / total : 0,
    manualArgCountAfterStart: cases.reduce((sum, c) => sum + c.metrics.manualArgCountAfterStart, 0),
    humanTurnsPerShip: shipped.length ? shipped.reduce((sum, c) => sum + c.metrics.humanTurns, 0) / shipped.length : 0,
  };
  const targetPassed =
    score.falseShipRate <= suite.targets.falseShipRate &&
    score.resumeSuccessRate >= suite.targets.resumeSuccessRate &&
    score.blockerAccuracy >= suite.targets.blockerAccuracy &&
    score.manualArgCountAfterStart <= suite.targets.manualArgCountAfterStart &&
    score.humanTurnsPerShip <= suite.targets.maxHumanTurnsPerShip;
  return { cases, score, targetPassed };
}

export function renderLoopEvalReport(report: LoopEvalReport): string {
  const lines = [
    "SER loop eval",
    `cases: ${report.score.passed}/${report.score.total}`,
    `resume_success_rate: ${pct(report.score.resumeSuccessRate)}`,
    `blocker_accuracy: ${pct(report.score.blockerAccuracy)}`,
    `false_ship_rate: ${pct(report.score.falseShipRate)}`,
    `manual_arg_count_after_start: ${report.score.manualArgCountAfterStart}`,
    `human_turns_per_ship: ${report.score.humanTurnsPerShip.toFixed(2)}`,
    `target: ${report.targetPassed ? "PASS" : "FAIL"}`,
    "",
  ];
  for (const result of report.cases) {
    lines.push(`${result.passed ? "PASS" : "FAIL"} ${result.id}`);
    for (const assertion of result.assertions.filter((a) => !a.passed)) {
      lines.push(`  - ${assertion.name}`);
    }
  }
  return lines.join("\n");
}

function pct(n: number): string {
  return `${Math.round(n * 1000) / 10}%`;
}
