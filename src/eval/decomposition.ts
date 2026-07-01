import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decompositionIssues, deriveV2, gateClusterHints } from "../contract/derive2.js";
import { parseSpec } from "../contract/spec.js";
import { MockLlm } from "../llm/mock.js";
import type { Gate } from "../contract/schema.js";

interface DecompositionEvalCaseResult {
  id: string;
  passed: boolean;
  detail: string;
}

export interface DecompositionEvalReport {
  cases: DecompositionEvalCaseResult[];
  score: {
    passed: number;
    total: number;
    rightSizeRate: number;
    repairRate: number;
  };
  targetPassed: boolean;
}

export async function evaluateDecompositionReliability(): Promise<DecompositionEvalReport> {
  const cases = [
    oversizedRejectedCase(),
    microSplitRejectedCase(),
    cohesivePlanAcceptedCase(),
    gateClusterHintsCase(),
    await oversizedRepairCase(),
  ];
  const passed = cases.filter((c) => c.passed).length;
  const rightSizeCases = cases.filter((c) => c.id !== "oversized-repair");
  const repairCases = cases.filter((c) => c.id === "oversized-repair");
  const score = {
    passed,
    total: cases.length,
    rightSizeRate: ratioPassed(rightSizeCases),
    repairRate: ratioPassed(repairCases),
  };
  return {
    cases,
    score,
    targetPassed: passed === cases.length && score.rightSizeRate === 1 && score.repairRate === 1,
  };
}

function gateClusterHintsCase(): DecompositionEvalCaseResult {
  const hints = gateClusterHints(
    [
      "python3 csv.py rows.csv | grep -q '3 rows'",
      "python3 csv.py cols.csv | grep -q 'name'",
      "python3 csv.py nums.csv | grep -q 'min'",
      "python3 csv.py nums.csv | grep -q 'max'",
      "python3 csv.py nums.csv | grep -q 'avg'",
      "python3 csv.py missing.csv 2>&1 | grep -qi 'not found'",
      "python3 csv.py empty.csv 2>&1 | grep -qi 'empty'",
      "python3 csv.py quoted.csv | grep -q 'Smith, John'",
      "cat data.csv | python3 csv.py --stdin | grep -q rows",
      "python3 csv.py bad.csv 2>&1 | grep -qi invalid",
    ].join(" && "),
    4,
  );
  return {
    id: "gate-cluster-hints",
    passed: hints.some((h) => h.startsWith("shape-summary")) && hints.some((h) => h.startsWith("numeric-stats")) && hints.some((h) => h.startsWith("errors")),
    detail: JSON.stringify(hints),
  };
}

function oversizedRejectedCase(): DecompositionEvalCaseResult {
  const issues = decompositionIssues(
    [{ id: "cli", blast_radius: ["cli.js"], deps: [] }],
    new Map([["cli", commandGate(Array.from({ length: 11 }, (_, i) => `node cli.js case${i}`).join(" && "))]]),
  );
  return {
    id: "oversized-rejected",
    passed: issues.some((i) => i.kind === "too_large"),
    detail: JSON.stringify(issues),
  };
}

function microSplitRejectedCase(): DecompositionEvalCaseResult {
  const nodes = Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, blast_radius: [`src/a${i}.js`], deps: [] }));
  const issues = decompositionIssues(nodes, new Map(nodes.map((n) => [n.id, commandGate(`node ${n.blast_radius[0]}`)])));
  return {
    id: "micro-split-rejected",
    passed: issues.some((i) => i.kind === "too_small"),
    detail: JSON.stringify(issues),
  };
}

function cohesivePlanAcceptedCase(): DecompositionEvalCaseResult {
  const issues = decompositionIssues(
    [
      { id: "core", blast_radius: ["src/core.js", "test/core.test.js"], deps: [] },
      { id: "cli", blast_radius: ["bin/cli.js", "test/cli.test.js"], deps: ["core"] },
    ],
    new Map([
      ["core", commandGate("npm test && node test/core.test.js && node test/edge.test.js")],
      ["cli", commandGate("node bin/cli.js sample.csv && node bin/cli.js --help")],
    ]),
  );
  return {
    id: "cohesive-plan-accepted",
    passed: issues.length === 0,
    detail: JSON.stringify(issues),
  };
}

async function oversizedRepairCase(): Promise<DecompositionEvalCaseResult> {
  const spec = parseSpec(`
thesis: build a tiny reporting CLI
scope_fence: []
requirements:
  - id: R1
    statement: "The CLI reports basic file facts"
    acceptance:
      tier: 1
      gate: node cli.js a && node cli.js b && node cli.js c && node cli.js d && node cli.js e && node cli.js f
  - id: R2
    statement: "The CLI reports numeric summaries"
    acceptance:
      tier: 1
      gate: node cli.js g && node cli.js h && node cli.js i && node cli.js j && node cli.js k && node cli.js l
decisions: []
claims: []
open_questions: []
`);
  const workdir = mkdtempSync(join(tmpdir(), "ser-decomposition-eval-"));
  writeFileSync(join(workdir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  const llm = new MockLlm([
    { text: JSON.stringify({ contract: "CLI contract", nodes: [{ id: "cli", brief: "build all CLI facts and numeric summaries", deps: [], context_globs: [], blast_radius: ["cli.js", "cli.test.js"], budget_usd: 1, requirement: "R1, R2" }] }) },
    { text: JSON.stringify({ contract: "CLI contract", nodes: [
      { id: "facts", brief: "build basic file facts", deps: [], context_globs: [], blast_radius: ["cli.js", "facts.test.js"], budget_usd: 0.5, requirement: "R1" },
      { id: "numeric", brief: "extend CLI with numeric summaries", deps: ["facts"], context_globs: ["cli.js"], blast_radius: ["cli.js", "numeric.test.js"], budget_usd: 0.5, requirement: "R2" },
    ] }) },
    { text: JSON.stringify({ claims: [] }) },
  ]);
  const result = await deriveV2({
    spec,
    workdir,
    llm,
    model: "mock",
    chainName: "cheap",
    budgetUsd: 2,
    executorModel: "qwen/qwen3-coder",
    nodeContextBudget: 24000,
  });
  const ids = result.ok ? result.mission.nodes.map((n) => n.id).join(",") : result.reasons.join("; ");
  return {
    id: "oversized-repair",
    passed: result.ok && ids === "facts,numeric" && !result.readback.includes("over-sized node"),
    detail: ids,
  };
}

function commandGate(run: string): Gate {
  return { type: "command", run, soft: false };
}

function ratioPassed(cases: DecompositionEvalCaseResult[]): number {
  return cases.length ? cases.filter((c) => c.passed).length / cases.length : 1;
}

export function renderDecompositionEvalReport(report: DecompositionEvalReport): string {
  const lines = [
    "SER decomposition eval",
    `cases: ${report.score.passed}/${report.score.total}`,
    `right_size_rate: ${pct(report.score.rightSizeRate)}`,
    `repair_rate: ${pct(report.score.repairRate)}`,
    `target: ${report.targetPassed ? "PASS" : "FAIL"}`,
    "",
  ];
  for (const result of report.cases) {
    lines.push(`${result.passed ? "PASS" : "FAIL"} ${result.id}`);
    if (!result.passed) lines.push(`  - ${result.detail}`);
  }
  return lines.join("\n");
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
