/**
 * Conversation eval harness for `ser talk` (the thing human dogfooding was doing
 * by hand, now automated and SCORED). A simulated-user agent drives the REAL
 * SpecSession against the real cheap model; each transcript is scored by a
 * MOSTLY-MECHANICAL rubric (re-ask detection, fact-recording, convergence,
 * present-on-request are all deterministic from the spec state) so the score is
 * not gameable prose-judging.
 *
 * Split: `scoreTranscript` and its helpers are PURE and hermetically tested.
 * `runScenario`/`simUserMessage` are LIVE (network) and run only from the
 * `pnpm talk-eval` script — never in the test suite (zero-network invariant).
 */
import type { LlmClient } from "../llm/types.js";

// ── Scenarios ──────────────────────────────────────────────────────────────

/** A fact only the user holds; `keywords` are substrings whose presence in the
 *  final decisions proves the engine RECORDED it (not just heard it). */
export interface HiddenFact {
  key: string;
  value: string;
  keywords: string[];
}

export interface Scenario {
  id: string;
  /** Who the simulated user is — shapes how they answer. */
  persona: string;
  /** The opening message (pins the thesis). */
  idea: string;
  facts: HiddenFact[];
  /** 1-based turn at which the user asks to SEE the plan (probes present-on-request). */
  showPlanTurn?: number;
  maxTurns: number;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "kid-companion",
    persona: "a non-technical parent who knows their child and hardware but not software",
    idea: "an ambient ai companion for my daughter on a laptop",
    facts: [
      { key: "age", value: "4", keywords: ["age", "4 year", "4-year", "four year", "age 4", "age is 4"] },
      { key: "hardware", value: "laptop", keywords: ["laptop"] },
      { key: "safety", value: "no violence, gentle topics only", keywords: ["no violence", "gentle"] },
    ],
    showPlanTurn: 4,
    maxTurns: 6,
  },
  {
    id: "habit-tracker",
    persona: "a busy professional who wants a simple personal tool",
    idea: "a habit tracker i can use on my phone",
    facts: [
      { key: "platform", value: "iphone", keywords: ["iphone", "ios"] },
      { key: "habits", value: "exercise and reading, daily", keywords: ["daily", "exercise", "reading"] },
    ],
    showPlanTurn: 3,
    maxTurns: 6,
  },
  {
    id: "recipe-box",
    persona: "a home cook who is clear about what they want",
    idea: "a recipe box that scales ingredient quantities",
    facts: [
      { key: "store", value: "local file, no cloud", keywords: ["local", "no cloud", "offline"] },
      { key: "scaling", value: "scale by number of servings", keywords: ["serving", "scale"] },
    ],
    showPlanTurn: 3,
    maxTurns: 6,
  },
];

// ── Transcript ─────────────────────────────────────────────────────────────

export interface EvalTurn {
  user: string;
  reply: string;
  /** The question the engine surfaced this turn (batch.question), "" if none. */
  asked: string;
  /** The harness action the engine requested (none|status|run|…). */
  action: string;
  /** True when this turn would present the plan (action==="status"). */
  presentedPlan: boolean;
  /** Blocking open_questions remaining after the turn. */
  blockingAfter: number;
  /** Whether the spec is buildable after the turn. */
  ready: boolean;
}

export interface Transcript {
  scenarioId: string;
  turns: EvalTurn[];
  finalDecisions: string[];
}

// ── Pure rubric ─────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "for", "and", "or", "to", "of", "in", "on", "at", "it", "this", "that",
  "what", "which", "your", "you", "her", "his", "their", "with", "do", "does", "should", "would", "i", "d", "s",
  "be", "have", "has", "will", "can", "we", "they", "how", "why", "when", "where", "who",
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** A fact is recorded iff some decision contains one of its proof keywords. */
export function factRecorded(fact: HiddenFact, decisions: string[]): boolean {
  const hay = decisions.join(" \n ").toLowerCase();
  return fact.keywords.some((k) => hay.includes(k.toLowerCase()));
}

const SHOW_PLAN_RE = /\b(architecture|components|the plan|the spec|requirements|show me|present)\b/i;
export function isShowPlanAsk(msg: string): boolean {
  return SHOW_PLAN_RE.test(msg);
}

export interface Score {
  /** Fraction of the user's hidden facts that ended up in the decisions (0..1). */
  factsRecorded: number;
  /** Questions re-asked (a later asked question ~matches an earlier one). */
  reasks: number;
  /** Turns that posed a question while nothing was open to ask (incoherence). */
  askedWhenSettled: number;
  /** 1-based turn the spec first became buildable, or null. */
  turnsToBuildable: number | null;
  buildable: boolean;
  /** Did the engine present the plan when the user asked? null = never asked. */
  presentedOnRequest: boolean | null;
  /** 0..100 composite (weights documented in the body). */
  overall: number;
}

const REASK_THRESHOLD = 0.5;

export function scoreTranscript(scenario: Scenario, t: Transcript): Score {
  // facts recorded — deterministic keyword presence in the final decisions
  const factsRecorded = scenario.facts.length
    ? scenario.facts.filter((f) => factRecorded(f, t.finalDecisions)).length / scenario.facts.length
    : 1;

  // re-asks — a non-empty asked question whose tokens ~match an earlier asked one
  let reasks = 0;
  const priorAsked: Set<string>[] = [];
  for (const turn of t.turns) {
    if (!turn.asked.trim()) continue;
    const toks = tokenize(turn.asked);
    if (priorAsked.some((p) => jaccard(p, toks) >= REASK_THRESHOLD)) reasks += 1;
    priorAsked.push(toks);
  }

  // incoherence — posed a question with zero blocking questions outstanding
  const askedWhenSettled = t.turns.filter(
    (turn) => turn.blockingAfter === 0 && turn.reply.trimEnd().endsWith("?"),
  ).length;

  const firstReadyIdx = t.turns.findIndex((turn) => turn.ready);
  const turnsToBuildable = firstReadyIdx === -1 ? null : firstReadyIdx + 1;
  const buildable = firstReadyIdx !== -1;

  // present-on-request — among turns the user asked to see the plan, did it show
  const askedTurns = t.turns.filter((turn) => isShowPlanAsk(turn.user));
  const presentedOnRequest = askedTurns.length === 0 ? null : askedTurns.every((turn) => turn.presentedPlan);

  // composite: facts 30, no-reasks 25, coherence 15, buildable 15, present 15
  let overall = 0;
  overall += 30 * factsRecorded;
  overall += 25 * Math.max(0, 1 - reasks / 3);
  overall += 15 * Math.max(0, 1 - askedWhenSettled / 2);
  overall += 15 * (buildable ? 1 : 0);
  overall += 15 * (presentedOnRequest === null ? 1 : presentedOnRequest ? 1 : 0);

  return {
    factsRecorded,
    reasks,
    askedWhenSettled,
    turnsToBuildable,
    buildable,
    presentedOnRequest,
    overall: Math.round(overall),
  };
}

/** A fixed-width score table across scenarios (for the script's stdout). */
export function formatScoreTable(rows: { scenario: string; score: Score }[]): string {
  const head = ["scenario", "facts", "reask", "incoh", "build@", "shown", "score"];
  const fmt = (r: { scenario: string; score: Score }): string[] => [
    r.scenario,
    `${Math.round(r.score.factsRecorded * 100)}%`,
    String(r.score.reasks),
    String(r.score.askedWhenSettled),
    r.score.turnsToBuildable === null ? "—" : `t${r.score.turnsToBuildable}`,
    r.score.presentedOnRequest === null ? "n/a" : r.score.presentedOnRequest ? "yes" : "NO",
    String(r.score.overall),
  ];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => fmt(r)[i]!.length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.score.overall, 0) / rows.length) : 0;
  return [line(head), ...rows.map((r) => line(fmt(r))), "", `mean score: ${avg}/100`].join("\n");
}

// ── Live runner (network — script only) ──────────────────────────────────────

export interface RunDeps {
  /** The engine under test (drives the real SpecSession). */
  mapperLlm: LlmClient;
  mapperModel: string;
  knightModel: string;
  /** The simulated user. */
  userLlm: LlmClient;
  userModel: string;
  /** Fresh spec file path for this scenario (created blank by the caller). */
  specPath: string;
}

const USER_SYSTEM = `You are role-playing a USER talking to an assistant that designs a software build
from your idea. Stay in character. Answer in ONE short, natural message (no lists,
no preamble). If the assistant asks something you know, answer it plainly. If it
already decided something correctly, don't repeat it. If it seems ready to build,
say exactly "build it". Never describe yourself as an AI.`;

/** Produce the simulated user's next message given the conversation so far. */
export async function simUserMessage(
  scenario: Scenario,
  lastAssistant: string,
  deps: RunDeps,
): Promise<string> {
  const facts = scenario.facts.map((f) => `- ${f.key}: ${f.value}`).join("\n");
  const res = await deps.userLlm.complete({
    model: deps.userModel,
    system: USER_SYSTEM,
    user:
      `You are ${scenario.persona}. You want to build: ${scenario.idea}\n\n` +
      `Facts you hold (only mention when relevant or asked):\n${facts}\n\n` +
      `The assistant just said:\n"${lastAssistant}"\n\nYour reply:`,
    maxTokens: 120,
  });
  return res.text.trim().replace(/^["']|["']$/g, "");
}
