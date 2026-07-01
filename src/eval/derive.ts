import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveV2 } from "../contract/derive2.js";
import { parseSpec } from "../contract/spec.js";
import { MockLlm } from "../llm/mock.js";
import { OpenRouterClient } from "../llm/openrouter.js";

export interface DeriveEvalCaseResult {
  id: string;
  passed: boolean;
  assertions: { name: string; passed: boolean; detail: string }[];
}

export interface DeriveEvalReport {
  cases: DeriveEvalCaseResult[];
  score: {
    passed: number;
    total: number;
    salvageRate: number;
    diagnosticsRate: number;
    providerRetryRate: number;
  };
  targetPassed: boolean;
}

const notesSpec = parseSpec(`
thesis: build a small local notes tool with tags, browser persistence, and a visible test result
scope_fence: []
requirements:
  - id: R1
    statement: "Implement the smallest useful version of: build a small local notes tool with tags, browser persistence, and a visible test result"
    acceptance:
      tier: 1
      gate: npm test -- --runInBand
  - id: R2
    statement: "The app renders a usable product UI in index.html, seeded with realistic sample content on first load."
    acceptance:
      tier: 1
      gate: npm run build --if-present
decisions: []
claims: []
open_questions: []
`);

const capturedKimiDecompose = {
  contract: "type Note = { id: string, title: string }",
  nodes: [
    {
      id: "server",
      brief: "Create Express server and CRUD API for notes.",
      deps: [],
      context_globs: [],
      blast_radius: "server.js, package.json, data/notes.json",
      budget_usd: 0.8,
      requirement: "R1",
    },
    {
      id: "frontend",
      brief: "Build phone-friendly UI in public/ with tag filtering and search.",
      deps: ["server"],
      context_globs: ["server.js"],
      blast_radius: "public/index.html, public/style.css, public/app.js",
      budget_usd: 1.2,
      requirement: "R1, R2",
    },
    {
      id: "tests",
      brief: "Add API and UI tests for create, delete, filter, and search.",
      deps: ["server", "frontend"],
      context_globs: ["server.js", "public/*"],
      blast_radius: "test/api.test.js, test/ui.spec.ts, package.json",
      budget_usd: 0.5,
      requirement: "R1",
    },
  ],
};

export async function evaluateDeriveReliability(): Promise<DeriveEvalReport> {
  const cases = [
    await capturedDecomposeSalvageCase(),
    await failedStageDiagnosticsCase(),
    await providerRouteRetryCase(),
    await providerEmptyContentRetryCase(),
  ];
  const total = cases.length;
  const passed = cases.filter((c) => c.passed).length;
  const salvageCases = cases.filter((c) => c.id.includes("salvage"));
  const diagnosticsCases = cases.filter((c) => c.id.includes("diagnostics"));
  const providerCases = cases.filter((c) => c.id.includes("provider"));
  const score = {
    passed,
    total,
    salvageRate: ratioPassed(salvageCases),
    diagnosticsRate: ratioPassed(diagnosticsCases),
    providerRetryRate: ratioPassed(providerCases),
  };
  return {
    cases,
    score,
    targetPassed: passed === total && score.salvageRate === 1 && score.diagnosticsRate === 1 && score.providerRetryRate === 1,
  };
}

async function capturedDecomposeSalvageCase(): Promise<DeriveEvalCaseResult> {
  const workdir = mkdtempSync(join(tmpdir(), "ser-derive-eval-salvage-"));
  writeFileSync(join(workdir, "package.json"), JSON.stringify({ scripts: { test: "vitest run", build: "vite build" } }));
  const llm = new MockLlm([
    { text: JSON.stringify(capturedKimiDecompose) },
    { text: JSON.stringify({ claims: [] }) },
  ]);
  const result = await deriveV2({
    spec: notesSpec,
    workdir,
    llm,
    model: "mock",
    chainName: "cheap",
    budgetUsd: 2.5,
    executorModel: "qwen/qwen3-coder",
    nodeContextBudget: 24000,
  });
  return resultFor("captured-decompose-salvage", [
    {
      name: "derive succeeded",
      passed: result.ok,
      detail: result.ok ? result.readback : result.reasons.join("; "),
    },
    {
      name: "did not fall back",
      passed: result.ok && !result.readback.includes("fallback planner"),
      detail: result.ok ? result.readback : "",
    },
    {
      name: "preserved planned nodes",
      passed: result.ok && result.mission.nodes.map((n) => n.id).join(",") === "server,frontend,tests",
      detail: result.ok ? result.mission.nodes.map((n) => n.id).join(",") : "",
    },
    {
      name: "normalized file radii",
      passed: result.ok && result.mission.nodes[0]?.blast_radius.join("|") === "server.js|package.json|data/notes.json",
      detail: result.ok ? JSON.stringify(result.mission.nodes[0]?.blast_radius) : "",
    },
  ]);
}

async function failedStageDiagnosticsCase(): Promise<DeriveEvalCaseResult> {
  const workdir = mkdtempSync(join(tmpdir(), "ser-derive-eval-diagnostics-"));
  const dumpPath = join(workdir, "stage-fail.json");
  const prev = process.env.SER_DUMP_STAGE_FAIL;
  process.env.SER_DUMP_STAGE_FAIL = dumpPath;
  try {
    const llm = new MockLlm([
      { text: JSON.stringify({ nodes: [] }) },
      { text: JSON.stringify({ nodes: [] }) },
    ]);
    const result = await deriveV2({
      spec: notesSpec,
      workdir,
      llm,
      model: "mock",
      chainName: "cheap",
      budgetUsd: 2.5,
      executorModel: "qwen/qwen3-coder",
      nodeContextBudget: 24000,
    });
    const dump = await import("node:fs").then((fs) => fs.readFileSync(dumpPath, "utf8"));
    return resultFor("failed-stage-diagnostics", [
      {
        name: "fallback used only after validation failure",
        passed: result.ok && result.readback.includes("fallback planner"),
        detail: result.ok ? result.readback : result.reasons.join("; "),
      },
      {
        name: "diagnostic contains raw parsed normalized issues",
        passed: dump.includes('"rawText"') && dump.includes('"parsed"') && dump.includes('"normalized"') && dump.includes('"validationIssues"'),
        detail: dump,
      },
    ]);
  } finally {
    if (prev === undefined) delete process.env.SER_DUMP_STAGE_FAIL;
    else process.env.SER_DUMP_STAGE_FAIL = prev;
  }
}

async function providerRouteRetryCase(): Promise<DeriveEvalCaseResult> {
  let calls = 0;
  const client = new OpenRouterClient({
    apiKey: "k",
    sleep: async () => {},
    fetchImpl: (async () => {
      calls += 1;
      return calls < 2
        ? jsonResponse({
            error: {
              message: "Provider returned error",
              metadata: {
                raw: "{\"message\":\"thinking mode  is not supported\"}",
                previous_errors: [{ code: 429, raw: "temporarily rate-limited upstream" }],
              },
            },
          }, 400)
        : jsonResponse({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as unknown as typeof fetch,
  });
  const r = await client.complete({ model: "m", system: "s", user: "u", maxTokens: 100 });
  return resultFor("provider-route-retry", [
    { name: "retried route error", passed: calls === 2, detail: String(calls) },
    { name: "returned successful content", passed: r.text === "{}", detail: r.text },
  ]);
}

async function providerEmptyContentRetryCase(): Promise<DeriveEvalCaseResult> {
  let calls = 0;
  const client = new OpenRouterClient({
    apiKey: "k",
    sleep: async () => {},
    fetchImpl: (async () => {
      calls += 1;
      return calls < 2
        ? jsonResponse({ choices: [{ finish_reason: "length", message: { content: "", reasoning: "thinking" } }], usage: { prompt_tokens: 1, completion_tokens: 4000 } })
        : jsonResponse({ choices: [{ message: { content: "{\"ok\":true}" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as unknown as typeof fetch,
  });
  const r = await client.complete({ model: "m", system: "s", user: "u", maxTokens: 100 });
  return resultFor("provider-empty-content-retry", [
    { name: "retried empty content", passed: calls === 2, detail: String(calls) },
    { name: "returned successful content", passed: r.text === "{\"ok\":true}", detail: r.text },
  ]);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ratioPassed(cases: DeriveEvalCaseResult[]): number {
  return cases.length ? cases.filter((c) => c.passed).length / cases.length : 1;
}

function resultFor(id: string, assertions: DeriveEvalCaseResult["assertions"]): DeriveEvalCaseResult {
  return {
    id,
    assertions,
    passed: assertions.every((a) => a.passed),
  };
}

export function renderDeriveEvalReport(report: DeriveEvalReport): string {
  const lines = [
    "SER derive reliability eval",
    `cases: ${report.score.passed}/${report.score.total}`,
    `salvage_rate: ${pct(report.score.salvageRate)}`,
    `diagnostics_rate: ${pct(report.score.diagnosticsRate)}`,
    `provider_retry_rate: ${pct(report.score.providerRetryRate)}`,
    `target: ${report.targetPassed ? "PASS" : "FAIL"}`,
    "",
  ];
  for (const result of report.cases) {
    lines.push(`${result.passed ? "PASS" : "FAIL"} ${result.id}`);
    for (const assertion of result.assertions.filter((a) => !a.passed)) {
      lines.push(`  - ${assertion.name}: ${assertion.detail}`);
    }
  }
  return lines.join("\n");
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
