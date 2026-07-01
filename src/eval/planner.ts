import { extractIdea } from "../contract/ingest.js";
import { specCompleteness } from "../contract/spec-completeness.js";
import { MockLlm, type MockLlmResponse } from "../llm/mock.js";

export interface PlannerEvalCaseResult {
  id: string;
  passed: boolean;
  assertions: { name: string; passed: boolean; detail: string }[];
}

export interface PlannerEvalReport {
  cases: PlannerEvalCaseResult[];
  score: {
    passed: number;
    total: number;
    validIdeaRate: number;
    scopeCreepRate: number;
  };
  targetPassed: boolean;
}

const localNotesIdea = {
  stories: [
    "I create a note with title, body, and tags",
    "I search notes by content",
    "I refresh the browser and notes are still present",
  ],
  components: [
    {
      statement: "local note editor",
      story: "I create a note with title, body, and tags",
      gate: { tier: 1, gate: "node --test" },
    },
  ],
  decisions: [],
};

export async function evaluatePlannerFrontDoor(): Promise<PlannerEvalReport> {
  const cases = [
    await malformedIdeaRepairCase(),
    await localScopeCase(),
  ];
  const total = cases.length;
  const passed = cases.filter((c) => c.passed).length;
  const validIdeaCases = cases.filter((c) => c.id.includes("idea"));
  const scopeCases = cases.filter((c) => c.id.includes("scope"));
  const score = {
    passed,
    total,
    validIdeaRate: validIdeaCases.length ? validIdeaCases.filter((c) => c.passed).length / validIdeaCases.length : 1,
    scopeCreepRate: scopeCases.length ? scopeCases.filter((c) => !c.passed).length / scopeCases.length : 0,
  };
  return {
    cases,
    score,
    targetPassed: passed === total && score.validIdeaRate === 1 && score.scopeCreepRate === 0,
  };
}

function response(value: unknown): MockLlmResponse {
  return { text: JSON.stringify(value) };
}

async function malformedIdeaRepairCase(): Promise<PlannerEvalCaseResult> {
  const llm = new MockLlm([
    { text: '{"stories":["broken"],"components":[],"decisions":[' },
    response(localNotesIdea),
  ]);
  const result = await extractIdea("build a small local notes tool", llm, "mock");
  return resultFor("malformed-idea-repair", [
    {
      name: "idea parses after repair",
      passed: result.stories.length === localNotesIdea.stories.length,
      detail: JSON.stringify(result.stories),
    },
    {
      name: "repair call was used",
      passed: llm.calls.length === 2 && llm.calls[1]?.system.includes("repair malformed JSON") === true,
      detail: String(llm.calls.length),
    },
  ]);
}

async function localScopeCase(): Promise<PlannerEvalCaseResult> {
  const llm = new MockLlm([
    response(["sync notes across devices"]),
    response(["backup notes"]),
    response(["sort notes by date"]),
    response(["import notes from file"]),
    response(["search notes by content"]),
    response(["undo delete note"]),
    response([
      "sync notes across devices",
      "backup notes",
      "sort notes by date",
      "import notes from file",
      "search notes by content",
      "undo delete note",
    ]),
  ]);
  const features = await specCompleteness(llm, "mock", {
    idea: "build a small local notes tool with tags and browser persistence",
    stated: localNotesIdea.stories,
    maxFeatures: 3,
  });
  const forbidden = features.filter((f) => /\b(sync|backup|import|export|cloud|account|device)\b/i.test(f));
  return resultFor("local-scope-product-instinct", [
    {
      name: "scope-creep features filtered",
      passed: forbidden.length === 0,
      detail: JSON.stringify(features),
    },
    {
      name: "feature additions capped",
      passed: features.length <= 3,
      detail: JSON.stringify(features),
    },
  ]);
}

function resultFor(id: string, assertions: PlannerEvalCaseResult["assertions"]): PlannerEvalCaseResult {
  return {
    id,
    assertions,
    passed: assertions.every((a) => a.passed),
  };
}

export function renderPlannerEvalReport(report: PlannerEvalReport): string {
  const lines = [
    "SER planner eval",
    `cases: ${report.score.passed}/${report.score.total}`,
    `valid_idea_rate: ${pct(report.score.validIdeaRate)}`,
    `scope_creep_rate: ${pct(report.score.scopeCreepRate)}`,
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
