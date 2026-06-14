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
import { z } from "zod";
import type { LlmClient } from "../llm/types.js";
import { SpecSchema, type Spec } from "../contract/spec.js";

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

function parseJsonLoose(text: string): unknown {
  const cleaned = text.replace(/```json?/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ══ TIER 1 — process quality: a funnel-aware judge of the EXTRACTION ══════════
// The mechanical rubric (scoreTranscript) catches re-asks/coherence/convergence.
// This judge assesses the thing mechanics can't: did the conversation extract
// the RIGHT decisions for the idea→build→polish funnel? Structured 1-5 per
// dimension (not a vibe number) so it supplements, not replaces, the mechanics.

const ProcessJudgmentSchema = z.object({
  forks: z.number().min(0).max(5), // asked the load-bearing forks, not trivia
  captured: z.number().min(0).max(5), // converted answers into recorded decisions
  defaulted: z.number().min(0).max(5), // defaulted tech choices instead of interrogating
  coherence: z.number().min(0).max(5), // moved coherently through the funnel
  reason: z.string().default(""),
});
export type ProcessJudgment = z.infer<typeof ProcessJudgmentSchema>;

const JUDGE_PROCESS_SYSTEM = `You judge how well an assistant ELICITED a buildable software spec from a user.
The assistant's job is a funnel: IDEA (surface the load-bearing forks + decisions
only the user can answer — hardware, audience, constraints — and default the tech
choices itself) → BUILD → POLISH. Score the EXTRACTION, not politeness.
Rate each 0-5:
- forks: did it ask the decisive forks (not trivia, not things it should default)?
- captured: did the user's answers become recorded DECISIONS (not dropped)?
- defaulted: did it default tech choices (libraries, storage) instead of asking?
- coherence: did it avoid re-asking settled things and move forward?
Output ONLY JSON: {"forks":n,"captured":n,"defaulted":n,"coherence":n,"reason":"..."}`;

export async function judgeProcess(
  scenario: Scenario,
  t: Transcript,
  llm: LlmClient,
  model: string,
): Promise<ProcessJudgment | null> {
  const convo = t.turns.map((x, i) => `T${i + 1} user: ${x.user}\nT${i + 1} assistant: ${x.reply || "(plan shown)"}`).join("\n");
  const res = await llm.complete({
    model,
    system: JUDGE_PROCESS_SYSTEM,
    user: `PRODUCT: ${scenario.idea}\n\nFINAL DECISIONS:\n${t.finalDecisions.map((d) => `- ${d}`).join("\n") || "(none)"}\n\nTRANSCRIPT:\n${convo}`,
    json: true,
    maxTokens: 400,
  });
  const parsed = ProcessJudgmentSchema.safeParse(parseJsonLoose(res.text));
  return parsed.success ? parsed.data : null;
}

/** 0..100 process score: 60% mechanical (scoreTranscript), 40% judge (if any). */
export function processScore(mech: Score, judge: ProcessJudgment | null): number {
  if (!judge) return mech.overall;
  const judgePct = ((judge.forks + judge.captured + judge.defaulted + judge.coherence) / 20) * 100;
  return Math.round(0.6 * mech.overall + 0.4 * judgePct);
}

// ══ TIER 2 — output quality vs a vanilla one-shot spec (the headline ablation) ══

export interface SpecQuality {
  gateCoverage: number; // fraction with ANY gate (tier>=1) — incl. human review
  objectiveRate: number; // fraction with an AUTOMATABLE gate (tier 1-3) — the loop metric
  ungated: number; // tier-0 count (no check at all)
  human: number; // tier-4 count (needs a human → breaks the unattended loop)
  factCoverage: number; // fraction of the user's facts that survived into the spec
  components: number; // requirement count (decomposition)
  composite: number; // 0..100
}

/**
 * Mechanical spec quality — scores ser-talk's spec AND the vanilla spec alike.
 * The composite is dominated by `objectiveRate`, NOT mere gate presence: a spec
 * whose gates are tier-4 "a human verifies it feels good" can't loop unattended,
 * which is the whole product. So those score low even though they're "gated".
 */
export function specQuality(spec: Spec, scenario: Scenario): SpecQuality {
  const reqs = spec.requirements;
  const gateCoverage = reqs.length ? reqs.filter((r) => r.acceptance.tier >= 1).length / reqs.length : 0;
  const objectiveRate = reqs.length ? reqs.filter((r) => r.acceptance.tier >= 1 && r.acceptance.tier <= 3).length / reqs.length : 0;
  const ungated = reqs.filter((r) => r.acceptance.tier === 0).length;
  const human = reqs.filter((r) => r.acceptance.tier === 4).length;
  const hay = [...spec.decisions.map((d) => d.statement), ...reqs.map((r) => r.statement), spec.thesis];
  const factCoverage = scenario.facts.length
    ? scenario.facts.filter((f) => factRecorded(f, hay)).length / scenario.facts.length
    : 1;
  const components = reqs.length;
  const decomp = components >= 2 && components <= 8 ? 1 : components === 1 ? 0 : 0.5;
  const composite = Math.round(50 * objectiveRate + 35 * factCoverage + 15 * decomp);
  return { gateCoverage, objectiveRate, ungated, human, factCoverage, components, composite };
}

/** Blind A/B assignment so the comparative judge can't tell which spec is which. */
export function blindAssign<T>(ser: T, vanilla: T, flip: boolean): { a: T; b: T; serIs: "A" | "B" } {
  return flip ? { a: vanilla, b: ser, serIs: "B" } : { a: ser, b: vanilla, serIs: "A" };
}

const VANILLA_SYSTEM = `You are a software architect. Given an idea and the user's constraints, produce a
build spec in ONE shot (no questions). Output ONLY JSON:
{"thesis":"...","requirements":[{"statement":"...","check":"shell/command test or null"}],"decisions":[{"statement":"..."}]}
Each requirement's "check" is an OBJECTIVE command that proves it works, or null if
none fits. Capture the user's stated constraints as decisions. Be concrete.`;

/** The same-facts one-shot baseline: what a plain LLM gives you with no process. */
export async function generateVanillaSpec(scenario: Scenario, llm: LlmClient, model: string): Promise<Spec> {
  const facts = scenario.facts.map((f) => `- ${f.key}: ${f.value}`).join("\n");
  const res = await llm.complete({
    model,
    system: VANILLA_SYSTEM,
    user: `IDEA: ${scenario.idea}\n\nUSER CONSTRAINTS:\n${facts}`,
    json: true,
    maxTokens: 1200,
  });
  const raw = parseJsonLoose(res.text) as
    | { thesis?: string; requirements?: { statement?: string; check?: string | null }[]; decisions?: { statement?: string }[] }
    | null;
  const reqs = (raw?.requirements ?? [])
    .filter((r) => r.statement)
    .map((r, i) => ({
      id: `R${i + 1}`,
      statement: r.statement!,
      acceptance: r.check ? { tier: 1 as const, gate: r.check } : { tier: 0 as const },
    }));
  const obj = {
    thesis: raw?.thesis || scenario.idea,
    stories: [],
    scope_fence: [],
    requirements: reqs.length > 0 ? reqs : [{ id: "R1", statement: scenario.idea, acceptance: { tier: 0 as const } }],
    decisions: (raw?.decisions ?? [])
      .filter((d) => d.statement)
      .map((d, i) => ({ id: `D${i + 1}`, statement: d.statement!, rationale: "one-shot baseline", claims: [] })),
    claims: [],
    open_questions: [],
  };
  return SpecSchema.parse(obj);
}

const PairVerdictSchema = z.object({
  a: z.object({ gates: z.number(), needs: z.number(), decomp: z.number() }).partial().passthrough(),
  b: z.object({ gates: z.number(), needs: z.number(), decomp: z.number() }).partial().passthrough(),
  winner: z.enum(["A", "B", "tie"]),
  reason: z.string().default(""),
});
export type PairVerdict = z.infer<typeof PairVerdictSchema>;

const JUDGE_PAIR_SYSTEM = `Two build specs (A and B) describe the SAME product. Judge which is better to
actually build. Score each 1-10 on: gates (are the acceptance checks objective and
strong?), needs (does it capture the user's stated constraints?), decomp (sensible
component breakdown?). Pick the overall winner. Be impartial — A and B are in
random order and you do not know how either was produced.
Output ONLY JSON: {"a":{"gates":n,"needs":n,"decomp":n},"b":{"gates":n,"needs":n,"decomp":n},"winner":"A"|"B"|"tie","reason":"..."}`;

function specForJudge(spec: Spec): string {
  const reqs = spec.requirements
    .map((r) => `  - ${r.statement} [check: ${r.acceptance.tier === 0 ? "none" : r.acceptance.tier === 4 ? r.acceptance.artifact : r.acceptance.gate}]`)
    .join("\n");
  const decs = spec.decisions.map((d) => `  - ${d.statement}`).join("\n") || "  (none)";
  return `thesis: ${spec.thesis}\nrequirements:\n${reqs}\ndecisions:\n${decs}`;
}

export async function judgeSpecPair(
  idea: string,
  specA: Spec,
  specB: Spec,
  llm: LlmClient,
  model: string,
): Promise<PairVerdict | null> {
  const res = await llm.complete({
    model,
    system: JUDGE_PAIR_SYSTEM,
    user: `PRODUCT: ${idea}\n\nSPEC A:\n${specForJudge(specA)}\n\nSPEC B:\n${specForJudge(specB)}`,
    json: true,
    maxTokens: 500,
  });
  const parsed = PairVerdictSchema.safeParse(parseJsonLoose(res.text));
  return parsed.success ? parsed.data : null;
}
