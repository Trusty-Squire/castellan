import { z } from "zod";
import { SquireError } from "../errors.js";
import type { LlmClient } from "../llm/types.js";
import { MissionSchema, GateSchema, type Mission, type Gate } from "./schema.js";
import { renderGate, serverGatePort, serveGateBriefNote, wrapWithServeGate } from "./gate-patterns.js";
import { gateProofread, repairUnsatisfiableGate } from "./gate-proofread.js";
import { CASTELLAN_IDENTITY, GATE_LADDER_DOC, gatePatternDoc } from "./self-knowledge.js";
import { buildRepoSurvey, tryParseJson, formatZodIssues } from "./derive.js";
import { type Spec, unanchoredRequirements, refutedDecisions, blockingQuestions } from "./spec.js";
import { packContext } from "../harness/context.js";

/**
 * derive-v2 — the herald pipeline (SPEC-v0.2 §6). Planning as a gated loop:
 * survey → decompose → infer-gates → extract-claims → adversarial-review →
 * compile+validate → readback. Each LLM stage is a cheap-model call with one
 * schema-retry; inter-stage gates are mechanical. Refusal over silent fallback.
 */

// --- stage output schemas ---

const DecomposeSchema = z.object({
  /**
   * The shared CONTRACT for the whole build: the canonical data shapes (named types
   * + fields) and module interfaces (exports + signatures) every node references.
   * Prepended to each brief so nodes build compatible pieces instead of each
   * inventing an incompatible schema (the N3 failure: one node's parser rejected its
   * own fixture because no shared shape was pinned). Concise — the interface, not a
   * design doc.
   */
  contract: z.string().default(""),
  nodes: z
    .array(
      z.object({
        id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
        brief: z.string().min(1),
        deps: z.array(z.string()).default([]),
        context_globs: z.array(z.string()).default([]),
        blast_radius: z.array(z.string().min(1)).min(1),
        budget_usd: z.number().positive(),
        /** Spec requirement this node satisfies (spec-mode). */
        requirement: z.string().optional(),
      }),
    )
    .min(1),
});

const InferGatesSchema = z.object({
  gates: z.array(
    z.object({
      node: z.string(),
      /** Preferred: select a library pattern. */
      pattern: z.string().optional(),
      // Values are usually strings/string[]; dom-behavior's `steps` is a JSON array of
      // step objects, so accept any JSON (renderGate validates per-pattern).
      params: z.record(z.string(), z.unknown()).default({}),
      /** Fallback: free-form shell (flagged in the readback). */
      freeform: z.string().optional(),
    }),
  ),
});

const ClaimsSchema = z.object({
  claims: z.array(
    z.object({
      id: z.string(),
      statement: z.string().min(1),
      loadBearing: z.boolean(),
      about: z.string().default(""),
    }),
  ),
});

const LensSchema = z.object({
  refuted: z.boolean(),
  evidence: z.string().default(""),
});

const RemedySchema = z.object({
  remedies: z.array(
    z.object({
      claim: z.string().default(""),
      // true = infeasible AS STATED but buildable with an obvious constraint;
      // false = impossible IN PRINCIPLE (honest halt).
      remediable: z.boolean(),
      constraint: z.string().default(""),
    }),
  ),
});

// --- result types ---

export interface ClaimVerdict {
  id: string;
  statement: string;
  loadBearing: boolean;
  lenses: { lens: string; refuted: boolean; evidence: string; discarded: boolean }[];
  refuted: boolean;
}

export interface DeriveRefusal {
  ok: false;
  reasons: string[];
  /** Per unanchorable requirement: the three remediations (SPEC-v0.2 §6.5). */
  remediations: { requirement: string; options: [string, string, string] }[];
}

export interface DeriveSuccess {
  ok: true;
  mission: Mission;
  claims: ClaimVerdict[];
  /** Free-form gates that bypassed the pattern library (surfaced, not hidden). */
  freeformGates: { node: string; run: string }[];
  readback: string;
  inTokens: number;
  outTokens: number;
  /**
   * Actual USD billed for the whole derivation, summed from the provider's
   * reported per-call cost (A36). Present only when at least one stage reported
   * a cost (OpenRouter via the egress grant); undefined when no call reported,
   * leaving cost to price-table estimation. The tokens above are always exact.
   */
  costUsd?: number;
}

export type DeriveV2Result = DeriveSuccess | DeriveRefusal;

export interface DeriveV2Input {
  /** Exactly one of goal | spec. */
  goal?: string;
  spec?: Spec;
  workdir: string;
  llm: LlmClient;
  /** The PLANNER model (chain.knight) — runs the AUTHORING stages (decompose, infer-gates,
   *  extract-claims). Authoring is premium by design; cheap×reliable is the BUILD loop only.
   *  Node sizing still targets the cheap `executorModel` envelope below. */
  model: string;
  /** Premium adversary (the knight) for the adversarial-review stage — a cheap model is an
   * incompetent adversary (it "refutes" trivially-true claims). Falls back to `model` if absent. */
  judgeModel?: string;
  chainName: string;
  budgetUsd: number;
  maxHumanChecks?: number;
  /**
   * The RUNTIME executor slug (chain.executor — e.g. qwen), NOT the planner. The
   * planner is the knight, but nodes are sized to the executor's working envelope,
   * so the decompose prompt must name the executor it is building FOR. Falls back to
   * `model` (the planner) only for callers that don't resolve a chain.
   */
  executorModel?: string;
  /**
   * The executor's effective working-context envelope in tokens (chain.node_context_budget).
   * Sizes each node at decompose time and is copied into every node's max_context_tokens.
   */
  nodeContextBudget?: number;
}

export interface DirectMissionItem {
  statement: string;
  acceptance?: Spec["requirements"][number]["acceptance"];
}

export interface DirectMissionInput {
  thesis: string;
  items: DirectMissionItem[];
  chainName: string;
  budgetUsd: number;
  maxHumanChecks?: number;
  idPrefix?: string;
}

/**
 * The decompose stage's anti-drift rule, and the ONLY product-shaping guidance the
 * planner gets — deliberately domain-agnostic (no dashboard/game/tarot/poker keyword
 * lists; those were overfit to a few demos). A strong cheap model fails a node not
 * because the task is hard but because the brief is abstract product-prose ("harden
 * normalization around untrusted payloads") that never pins the data shape, the
 * exports, or the upstream it builds on — so it invents an incompatible schema and
 * trips over it. Briefs must stay concise about intent but concrete about the
 * INTERFACE, all referencing one shared contract. This is what keeps the build on
 * the cheap rung — escalation is a rare backstop, not the mechanism.
 */
export const CONTRACT_FIRST =
  "CONTRACT-FIRST (so the cheap executor succeeds first try, not via escalation): emit a concise shared `contract` — the canonical data shapes (named types with their fields and value types) and the module interfaces (the exact exports and their signatures) that nodes share. Then make each brief CONCRETE ABOUT THE INTERFACE and concise about intent: name the contract types it consumes and produces, the functions/exports it must create with their signatures, and which prior node's output it builds on. A brief that only gestures at intent ('harden normalization', 'validate payloads') WITHOUT naming the data shape, the exports, and the upstream contract is REJECTED — the executor sees only its brief and will invent an incompatible schema. Keep the contract concise: the shared interface, not a design doc. " +
  "FOR A UI PRODUCT, the contract MUST also include a DOM CONTRACT and behaviors must be OWNED, not split away: (1) pin STABLE selector hooks for the interactive elements as data-* attributes or ids (e.g. [data-testid=pot], [data-action=raise], [data-card], [data-disabled-when-not-turn]); (2) state each key INTERACTIVE BEHAVIOR as an observable cause→effect on those hooks (clicking [data-action=raise] increases [data-testid=pot]; [data-card] flips face-up on reveal; a control is disabled off-turn). Do NOT carve a UI into a render-only node plus a logic node such that NO node owns the interaction — the node that renders an interactive surface OWNS its behavior (wire it to the data/API it needs) so its gate can drive the page and assert the effect. A frontend brief that only 'renders DOM elements' with no named hooks and no cause→effect behavior is REJECTED — its gate decays to grepping for a class name. (3) The UI build MUST expose a START COMMAND — `npm start` that serves the app on a fixed localhost port — so the gate can boot it, drive it, and tear it down; name that port in the contract.";

/**
 * GATE/NODE COHERENCE — the auth_module failure: the decomposer mapped an INTEGRATION
 * requirement (a gate that boots a live server and curls a login→keys→credential flow)
 * onto a narrow LIBRARY node (build auth.py), with deps=[] and context=[] and a
 * blast_radius that couldn't even write the server. No model — cheap OR frontier — can
 * pass a gate whose acceptance exercises modules and state the node can neither build,
 * see, nor seed. A node FAILS FOREVER (honest-halt, wasted ladder) when its acceptance
 * is unsatisfiable within its own scope, so the decomposer must keep gate granularity
 * and node granularity aligned.
 */
export const COHERENCE_RULE =
  "GATE/NODE COHERENCE (a node can NEVER pass if its acceptance isn't satisfiable within its own scope — the worst plan bug): every requirement you map to a node (its `requirement` field) MUST be satisfiable BY THAT NODE ALONE — the node's brief + blast_radius + deps + context_globs must let ONE executor build and RUN everything that requirement's acceptance check exercises. A requirement whose check starts a LIVE SERVER and curls endpoints, or otherwise drives an END-TO-END flow spanning modules, is an INTEGRATION requirement: map it to ONE node that (a) builds the runnable server in its OWN blast_radius (it can write the server file), (b) DEPENDS ON (deps) and PACKS (context_globs) every module that flow wires together, and (c) whose own check sets up its preconditions. NEVER map a live-server / end-to-end requirement onto a narrow LIBRARY module (an auth helper, a storage helper) that cannot run the server or see the other modules — that node can never pass. A library module gets a requirement whose check is a UNIT test of that module's OWN exports. Requirements that only make sense together (a login and the keys it then returns) belong on the SAME integration node, not split across module nodes.";

/**
 * Node SIZING — replaces the "1-12 nodes" count anchor. LLM outputs anchor hard to
 * an embedded number (~88% of the time per anchoring research, and prompt-softening
 * doesn't fix it), so we do NOT ask for a count: node count is whatever falls out of
 * sizing each unit to the EXECUTOR's working envelope. The proxy is LOC/files (LLMs
 * estimate those far better than their own token counts); the harness keeps the token
 * budget as the objective backstop (an over-budget pack truncates and is caught).
 */
export const SIZING_RULE =
  "SIZE EACH NODE TO THE EXECUTOR'S ENVELOPE, NOT A COUNT: a node is ONE cohesive module or capability (plus its tests) the cheap executor finishes reliably in a single focused turn. Make each node as LARGE as stays reliably workable; split a unit ONLY when it would exceed roughly 150-250 lines of new code, touch more than ~3 source files, or need to read more than the per-node context budget stated below. The node COUNT is emergent — a small task may be 2 nodes, a large one 9. Do NOT aim for any particular count and do NOT pad to fill a range.";

/** The executor envelope line appended after SIZING_RULE so the "context budget
 *  stated below" it references is concrete. Names the runtime executor the plan is
 *  sized FOR (not the planner) and its token envelope. */
function envelopeRule(executor: string, budgetTokens: number): string {
  return `EXECUTOR ENVELOPE: each node is built by a cheap executor (${executor}) that reliably holds about ${budgetTokens} tokens of working context per node. Size every node so the files it must read PLUS the code it writes fit comfortably inside that — this, not a node-count target, is what bounds a node.`;
}

/** A node may name SEVERAL requirements (comma/whitespace separated) — the coverage
 *  gate no longer forces one node per requirement. Returns the trimmed ids. */
export function nodeRequirementIds(n: { requirement?: string }): string[] {
  if (!n.requirement) return [];
  return n.requirement
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Per-node USD allocation with a FLOOR + escalation reserve, applied BEFORE any
 * complexity-proportional weighting (eng review: budget-proportional allocation can
 * starve a small-but-hard node of escalation headroom). The planner's per-node
 * weights set the SHAPE; this guarantees every node clears a floor and holds back a
 * reserve fraction of the mission budget for the escalation ladder. Rounded to cents,
 * never below 0.01.
 */
export function allocateNodeBudgets(weights: number[], missionBudget: number): number[] {
  const FLOOR = 0.05; // minimum a node gets even if the planner weighted it ~0
  const RESERVE_FRAC = 0.2; // held back from per-node distribution for escalation headroom
  const n = weights.length;
  if (n === 0) return [];
  const cents = (x: number): number => Math.max(0.01, Math.round(x * 100) / 100);
  const pool = Math.max(0, missionBudget * (1 - RESERVE_FRAC));
  // If even the floors don't fit, split the pool evenly (degenerate tiny-budget case).
  if (pool <= FLOOR * n) return weights.map(() => cents(pool / n));
  const extra = pool - FLOOR * n;
  const wsum = weights.reduce((a, b) => a + Math.max(0, b), 0) || n;
  return weights.map((w) => cents(FLOOR + extra * (Math.max(0, w) / wsum)));
}

/**
 * Conservative DERIVE-TIME overflow filter (plan step 3). Flags a node whose
 * ALREADY-EXISTING context_globs pack beyond the executor envelope — a clear
 * mis-plan we can catch before any tokens burn. Deliberately weak: it cannot see
 * files FUTURE nodes will create, and the runtime adds blast_radius paths to the
 * pack anyway, so the real safety net is the runtime `pack.truncated` → halt (step
 * 4). Returns the offending node ids with their measured size.
 */
export function overflowingNodes(
  workdir: string,
  nodes: { id: string; context_globs: string[] }[],
  budgetTokens: number,
): { id: string; estTokens: number }[] {
  const over: { id: string; estTokens: number }[] = [];
  for (const n of nodes) {
    if (n.context_globs.length === 0) continue;
    // Pack with an effectively unbounded cap so estTokens reflects the TRUE size
    // (packContext keeps at least one file, so a single huge file still registers).
    const pack = packContext({ workdir, globs: n.context_globs, maxTokens: Number.MAX_SAFE_INTEGER });
    if (pack.estTokens > budgetTokens) over.push({ id: n.id, estTokens: pack.estTokens });
  }
  return over;
}

/** Trim the repository survey before it goes into the decompose prompt — keeps the
 *  stage within token budget. Domain-agnostic: a flat size cap, no app-type heuristic. */
export function trimSurveyForDecompose(survey: string): string {
  return survey.length > 4000 ? survey.slice(0, 4000) : survey;
}

// --- LLM stage helper: one schema-retry, refusal on second failure ---

/** Token + reported-cost accumulator threaded through every pipeline stage. */
interface PlannerUsage {
  in: number;
  out: number;
  /** Sum of provider-reported per-call cost (A36). */
  costUsd: number;
  /** How many calls reported a cost — 0 means fall back to estimation. */
  reportedCalls: number;
}

async function jsonStage<S extends z.ZodTypeAny>(
  llm: LlmClient,
  model: string,
  stage: string,
  system: string,
  user: string,
  schema: S,
  usage: PlannerUsage,
): Promise<z.output<S>> {
  let note = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await llm.complete({ model, system, user: user + note, json: true, maxTokens: 4000 });
    usage.in += res.inTokens;
    usage.out += res.outTokens;
    if (typeof res.costUsd === "number" && Number.isFinite(res.costUsd)) {
      usage.costUsd += res.costUsd;
      usage.reportedCalls += 1;
    }
    const parsed = tryParseJson(res.text);
    if (parsed.ok) {
      const checked = schema.safeParse(parsed.value);
      if (checked.success) return checked.data;
      note = `\n\nYour previous output failed validation:\n${formatZodIssues(checked.error.issues)}\nOutput corrected JSON only.`;
    } else {
      note = `\n\nYour previous output was not valid JSON: ${parsed.error}. Output JSON only.`;
    }
  }
  throw new SquireError("DERIVE_STAGE_INVALID", `stage "${stage}" produced invalid output after one retry`);
}

// The adversary's bar is FEASIBILITY, not perfection. Refute only when the plan genuinely
// CANNOT be built or CANNOT pass its own stated acceptance gates — never because a reasonable,
// hobby-grade implementation could be more robust, more general, or more like an industrial
// system. "It won't match NLTK / it lacks SQLite's test suite" is NOT a refutation; "it is
// mathematically impossible in the stated budget/time" is.
const FEASIBILITY_GUARD =
  " REFUTE ONLY GENUINE INFEASIBILITY: the claim makes the project impossible, or a reasonable implementation could not pass the spec's OWN stated acceptance gates. Do NOT refute because it could be more robust/general/industrial, or fails to handle cases no gate requires. A simple, reasonable, hobby-grade build that satisfies the stated stories is NOT refutable. SCOPE: only judge claims about whether THE PRODUCT CAN BE BUILT and pass its gates. If the claim is not a buildability claim — e.g. a descriptive meta-claim about the spec's wording or contents ('the requirements mention X', 'the spec describes Y') — it is OUT OF SCOPE: return refuted:false. Refuting such a claim says nothing about feasibility and must never block the build. When in doubt, do NOT refute." +
  " POLARITY — THIS IS WHERE ADVERSARIES GET IT BACKWARDS: naming prior art, a formula, or real systems that SUCCESSFULLY do this is the OPPOSITE of a refutation. It PROVES the claim is buildable → you MUST return refuted:false. Set refuted:true ONLY when your evidence shows the build genuinely CANNOT succeed (a hard impossibility — physics, arithmetic, combinatorics — not 'could be better'). If your evidence reads as 'this is buildable', 'a practical build path exists', 'existing systems already do this', or 'matches the acceptance logic', that is refuted:false. Evidence that affirms feasibility can NEVER accompany refuted:true.";

/**
 * Polarity guard: a refutation whose evidence actually AFFIRMS buildability is the
 * model getting the direction backwards (it cited prior art that SUCCEEDS, or a
 * working formula, then ticked refuted:true). Such "refutations" must be discarded
 * — naming systems that already do the thing proves it's buildable, it cannot
 * block the build. These patterns appear only when the evidence argues FOR
 * feasibility; genuine refutations ("10^160 states >> age of the universe") never
 * match them.
 */
const BUILDABILITY_AFFIRMATIONS: RegExp[] = [
  /\bbuildable\b/i,
  /practical build path/i,
  /rather than (an? )?infeasible/i,
  /matching the (claim|acceptance|gate)/i,
  /matches the (claim|acceptance)/i,
  /demonstrates? (that )?(this|it) (is|can)/i,
  /(already|routinely) (do|does|implement|perform)/i,
  /\bis (clearly )?(buildable|feasible|doable)\b/i,
  /existing (systems|practice|tooling) (already )?(do|implement|show)/i,
  /use decimal arithmetic librar(?:y|ies)/i,
  /\b(decimal\.js|big\.js)\b/i,
  /standard (mitigation|workaround|library)/i,
];

export function affirmsBuildability(evidence: string): boolean {
  return BUILDABILITY_AFFIRMATIONS.some((re) => re.test(evidence));
}

/**
 * Ground a gate command in tools that exist: rewrite the bare `python`/`pip`
 * interpreter to `python3`/`pip3`. Many environments lack the `python` alias, so a
 * gate authored as `python - <<PY` exits 127 and halts the build for no real
 * reason. Deterministic and source-agnostic — fixes spec-authored gates and
 * inferred ones alike. Only touches the interpreter word, never `python3` (the
 * negative lookahead) and never substrings inside other words.
 */
export function groundGateRun(run: string): string {
  return stripCaseFilters(
    run
      .replace(/\bpython\b(?!3)/g, "python3")
      .replace(/\bpip\b(?!3)/g, "pip3")
      .replace(/(^|[;&|(\n]\s*)pytest\b/g, "$1python3 -m pytest"),
  );
}

/**
 * Long-form "filter to a named test case" flags. A test gate should run the
 * whole test FILE — the file's assertions ARE the check; filtering to one named
 * case is fragile (the name must match the author's invented string exactly) and
 * buys no extra safety. Worse, the cheap authoring layer hallucinates flags that
 * don't exist in any runner (`--case` is not a vitest/jest/pytest flag — it exits
 * non-zero on the bad argument before a single test runs, halting the build for
 * nothing). We strip these long-form filters and their value, keeping the
 * file-level run. Single-char flags (`-t`, `-g`, `-k`) are left alone: too
 * collision-prone to strip safely (`tsc -t es2020` is not a test filter).
 */
const CASE_FILTER =
  /\s--(?:case|grep|name|scenario|test-?case|test-?name-?pattern|testNamePattern)(?:=|\s+)(?:'[^']*'|"[^"]*"|\S+)/gi;

/** Drop hallucinated/fragile named-case filter flags so the gate runs the test file. */
export function stripCaseFilters(run: string): string {
  return run.replace(CASE_FILTER, "");
}

/** A PROJECT-WIDE end-to-end SUITE at the node level stays intractable (a single cheap
 *  node can't stand up a whole `test:e2e` harness + cypress from nothing) → downgrade it.
 *  But a SINGLE-FILE playwright behavioral spec (`npx playwright test one.spec.ts`) is now
 *  tractable — the harness installs playwright+chromium — and is the deterministic UI gate
 *  we WANT, so it must NOT match here. (We learned the visual audit is too lenient to be
 *  the home for browser verification; a per-node spec beats punting to a judge.) */
const E2E_GATE = /\b(cypress|webdriver\.?io)\b|\bnpm run (test:e2e|e2e)\b|\btest:e2e\b/i;

/** A tractable build floor: install deps if needed, then compile (no-op when there's
 *  no build script). Something a single cheap node can actually pass. */
const E2E_BUILD_FLOOR = "if [ ! -d node_modules ]; then npm install --no-fund --no-audit; fi && npm run build --if-present";

/**
 * Make a gate tractable for the cheap build loop: ground tools (python→python3),
 * then DOWNGRADE any node-level e2e/browser gate to the build floor. We do NOT try
 * to make e2e gates work per-node (a single node can't stand up Playwright + a
 * project-wide harness) — the live visual audit carries the real end-to-end teeth,
 * so end-to-end verification is relocated there. Non-e2e gates pass through
 * unchanged (just grounded).
 */
export function tractableGateRun(run: string): string {
  const grounded = groundGateRun(run);
  if (E2E_GATE.test(grounded)) return E2E_BUILD_FLOOR;
  return canonicalizeTestGate(grounded);
}

/** A gate whose payload is running the test suite (npm test / vitest / jest). */
const TEST_RUN_GATE = /\bnpm test\b|\bnpx? +vitest\b|\bnpx? +jest\b/i;
/** A gate that ALSO builds, greps, curls, or drives a browser has a non-test
 *  payload we must preserve — not a pure test-run gate. */
const COMPOUND_PAYLOAD = /\bnpm run build\b|\bgrep\b|\bcurl\b|\bplaywright\b|\bcypress\b/i;

/**
 * Canonicalize a pure test-runner gate to the whole vitest suite (`npm test`).
 * The cheap builder writes real tests but names files its own way, and the gate
 * authoring emits jest idioms — `--runTestsByPath` (a flag vitest rejects with
 * CACError), `--case`, and pinned `tests/exact-name.test.js` paths — each a 254/1
 * halt on a non-reason when the model named the file differently or the runner
 * differs. Running the whole suite is robust to filename/extension/flag drift, and
 * "all unit tests green" is the invariant the build loop actually wants per node
 * (the scaffolded vitest config excludes e2e/playwright specs so they don't choke
 * the unit run). Applied ONLY when the gate is purely a test run — compound gates
 * (build+grep UI checks, e2e build floors) keep their payload.
 */
export function canonicalizeTestGate(run: string): string {
  if (!TEST_RUN_GATE.test(run) || COMPOUND_PAYLOAD.test(run)) return run;
  return "npm test";
}

export const LENSES: { id: string; instruction: string }[] = [
  {
    id: "feasibility-arithmetic",
    instruction:
      "Attack this claim with ARITHMETIC: estimate sizes, counts, time, memory, cost. If the numbers genuinely do not work, refute and SHOW the arithmetic as evidence. A refutation without shown arithmetic is worthless." +
      FEASIBILITY_GUARD,
  },
  {
    id: "prior-art",
    instruction:
      "Attack this claim with PRIOR ART: does existing practice show this approach genuinely CANNOT work? If so, refute and NAME the systems/sources. A refutation without named prior art is worthless." +
      FEASIBILITY_GUARD,
  },
];

/** Pinned DOM hooks ([data-testid=x], [data-action=x], [data-card], …) a brief names. */
const DOM_HOOK_RE = /\[data-[a-z][a-z0-9-]*(?:=[a-zA-Z0-9_-]+)?\]/g;
export function extractDomHooks(text: string): string[] {
  return [...new Set(text.match(DOM_HOOK_RE) ?? [])];
}

/**
 * Harness-derived UI gate. The planner will NOT reliably SELECT the dom-behavior pattern
 * (it stays anchored on curl/grep/vitest — measured 4×), so when a node's brief PINS DOM
 * hooks we DERIVE a deterministic presence gate ourselves and attach it: assert each pinned
 * hook renders. This is the "harness does, not coaxes" move — exit-code UI teeth without a
 * VLM and without trusting the model's gate choice. Presence is the floor (an empty-but-present
 * element still passes — that residual is the visual judge's job); behavior/quality is layered on top.
 */
export function deriveUiGate(node: { brief: string }, contract = ""): Gate | null {
  // Hooks are pinned in the shared CONTRACT (per CONTRACT-FIRST), not always repeated in
  // the node brief — so read both.
  const hooks = extractDomHooks(`${node.brief}\n${contract}`);
  if (hooks.length === 0) return null; // no pinned hooks → can't gate the DOM deterministically
  const steps = hooks.map((h) => ({ assert: h, exists: true }));
  return renderGate("dom-behavior", { url: "http://localhost:3000", steps, serve: "npm start" });
}

/** A node that renders a frontend surface — its blast_radius/context are UI files. */
const UI_GLOB_RE = /\.(html|css|jsx|tsx|vue|svelte)\b|\bindex\.html\b|\bpublic\/|\bfrontend\/|\bsrc\/(app|components|ui|pages|styles)\b/i;
export function looksLikeUi(node: { blast_radius?: string[]; context_globs?: string[] }): boolean {
  return UI_GLOB_RE.test([...(node.blast_radius ?? []), ...(node.context_globs ?? [])].join(" "));
}

// --- the pipeline ---

export async function deriveV2(input: DeriveV2Input): Promise<DeriveV2Result> {
  if (Boolean(input.goal) === Boolean(input.spec)) {
    throw new SquireError("DERIVE_INPUT", "deriveV2 takes exactly one of goal | spec");
  }
  const usage: PlannerUsage = { in: 0, out: 0, costUsd: 0, reportedCalls: 0 };
  const { llm, model, judgeModel } = input;

  // Spec pre-gates: unanchored requirements and refuted decisions block before any tokens.
  if (input.spec) {
    const refusal = specPreGate(input.spec);
    if (refusal) return refusal;
  }

  // 1. survey (mechanical)
  const survey = await buildRepoSurvey(input.workdir);
  const intent = input.spec
    ? `THESIS:\n${input.spec.thesis}\n\nREQUIREMENTS:\n${input.spec.requirements
        .map((r) => `${r.id}: ${r.statement} [acceptance tier ${r.acceptance.tier}${r.acceptance.gate ? `: ${r.acceptance.gate}` : ""}${r.acceptance.artifact ? `: ${r.acceptance.artifact}` : ""}]`)
        .join("\n")}\n\nSCOPE FENCE:\n${input.spec.scope_fence.join("\n") || "(none)"}`
    : `GOAL:\n${input.goal}`;
  const decomposeSurvey = trimSurveyForDecompose(survey);

  // 2. decompose — NO node-count anchor. Sizing is by the executor envelope; the
  // count is emergent. Coverage stays mandatory but no longer forces one node per
  // requirement (a node may name several) — that was a second, independent count
  // inflator on top of the old "1-12" anchor.
  const executor = input.executorModel ?? input.model;
  const envelopeTokens = input.nodeContextBudget ?? 40000;
  const coverageRule = input.spec
    ? ` SPEC MODE — COVERAGE IS MANDATORY (but does NOT dictate node count): the requirements above are labelled ${input.spec.requirements
        .map((r) => r.id)
        .join(", ")}. EVERY requirement id MUST be covered by at least one node, and EVERY node MUST name the requirement(s) it implements in its "requirement" field. ONE node MAY satisfy SEVERAL requirements — list them comma-separated (e.g. "${input.spec.requirements
        .slice(0, 2)
        .map((r) => r.id)
        .join(", ")}"). Do NOT add nodes just to reach a one-node-per-requirement mapping; size nodes by the envelope rule above, not by the requirement count.`
    : "";
  const decomposeSystem =
    `${CASTELLAN_IDENTITY}\n\nYour role, the Herald: decompose work into a DAG of nodes. ${SIZING_RULE} ${envelopeRule(executor, envelopeTokens)} Briefs are self-contained (the executor sees ONLY the brief and its packed files). blast_radius is the narrowest glob set permitting the work. Distribute the budget. Do NOT write gates yet.${coverageRule} ${CONTRACT_FIRST} ${COHERENCE_RULE} Output ONLY JSON: {"contract":"<shared data shapes + module signatures>","nodes":[{id,brief,deps,context_globs,blast_radius,budget_usd,requirement?}]}.`;
  const decomposeUser = `${intent}\n\nREPOSITORY SURVEY:\n${decomposeSurvey}\n\nMISSION BUDGET USD: ${input.budgetUsd}`;
  let decomposed = await jsonStage(llm, model, "decompose", decomposeSystem, decomposeUser, DecomposeSchema, usage);

  // spec-mode coverage gate: every requirement maps to >=1 node (a node may carry
  // several). The retry repairs coverage by REASSIGNING ids to existing nodes — it
  // must NOT instruct the model to add/split nodes (that re-inflates the count).
  if (input.spec) {
    let covered = new Set(decomposed.nodes.flatMap(nodeRequirementIds));
    let missing = input.spec.requirements.filter((r) => !covered.has(r.id)).map((r) => r.id);
    if (missing.length > 0) {
      decomposed = await jsonStage(
        llm,
        model,
        "decompose:coverage-retry",
        decomposeSystem,
        `${decomposeUser}\n\nYour previous decomposition left these requirement ids uncovered: ${missing.join(", ")}.\nAssign each uncovered id to the single most appropriate EXISTING node by adding it to that node's "requirement" field (comma-separated — one node may list several). Do NOT add or split nodes just to cover requirements; keep node sizing driven by the executor envelope.`,
        DecomposeSchema,
        usage,
      );
      covered = new Set(decomposed.nodes.flatMap(nodeRequirementIds));
      missing = input.spec.requirements.filter((r) => !covered.has(r.id)).map((r) => r.id);
    }
    if (missing.length > 0) {
      return { ok: false, reasons: [`decomposition covers no node for requirement(s): ${missing.join(", ")}`], remediations: [] };
    }
  }

  // 2b. Conservative derive-time overflow filter (step 3): a node whose EXISTING
  // context already blows the executor envelope is a mis-plan — refuse so the funnel
  // re-derives, BEFORE spending gate-inference tokens. Weak by design (blind to files
  // future nodes create); the runtime pack.truncated → halt is the real safety net.
  const overflow = overflowingNodes(input.workdir, decomposed.nodes, envelopeTokens);
  if (overflow.length > 0) {
    return {
      ok: false,
      reasons: overflow.map(
        (o) =>
          `node "${o.id}" over-scoped: its context_globs already pack to ~${o.estTokens} tokens, over the executor envelope of ${envelopeTokens} — split this node or narrow its context_globs.`,
      ),
      remediations: [],
    };
  }

  // 3. infer-gates — spec acceptance wins; otherwise select from the pattern library.
  // A node may now map to SEVERAL requirements, so the gate must verify the WHOLE
  // unit (the aggregate-gate principle: a multi-requirement node, like a split, is a
  // verification loophole unless its gate covers all of them). Aggregation:
  //   • any tier-4 requirement  → human signoff dominates (the unit needs a person)
  //   • all tier-1/2            → AND the concrete commands into one gate
  //   • some tier-3/unanchorable → infer ONE gate, then AND on any concrete commands
  const gatesByNode = new Map<string, Gate>();
  const freeformGates: { node: string; run: string }[] = [];
  // Concrete acceptance commands to AND onto a node's inferred gate (mixed-tier nodes).
  const concreteExtra = new Map<string, string[]>();
  const needsInference = decomposed.nodes.filter((n) => {
    const reqs = nodeRequirementIds(n)
      .map((id) => input.spec?.requirements.find((r) => r.id === id))
      .filter((r): r is NonNullable<typeof r> => Boolean(r));
    if (reqs.length === 0) return true; // goal-mode, or a node mapped to no real requirement
    if (reqs.some((r) => r.acceptance.tier === 4)) {
      const artifact = reqs
        .filter((r) => r.acceptance.tier === 4)
        .map((r) => r.acceptance.artifact!)
        .join(", ");
      gatesByNode.set(n.id, { type: "human", artifact, soft: false });
      return false;
    }
    const concreteCmds = [
      ...new Set(reqs.filter((r) => r.acceptance.tier >= 1 && r.acceptance.tier <= 2).map((r) => r.acceptance.gate!)),
    ];
    const needInfer = reqs.filter((r) => !(r.acceptance.tier >= 1 && r.acceptance.tier <= 2) && r.acceptance.tier !== 4);
    if (needInfer.length === 0) {
      // all concrete → aggregate gate (AND verifies every requirement on the node)
      const anyMetric = reqs.some((r) => r.acceptance.tier === 2);
      gatesByNode.set(
        n.id,
        GateSchema.parse({ type: anyMetric ? "metric" : "command", run: concreteCmds.join(" && "), soft: false }),
      );
      return false;
    }
    // mixed: an inferred gate covers the tier-3 part; remember the concrete commands
    // to AND on after inference so the auto-anchored requirements are still verified.
    if (concreteCmds.length > 0) concreteExtra.set(n.id, concreteCmds);
    return true; // tier 3 or unanchorable handled by inference below
  });

  if (needsInference.length > 0) {
    const inferSystem = `${CASTELLAN_IDENTITY}\n\nYour role: select objective gates for plan nodes.\n\n${GATE_LADDER_DOC}\n\n${gatePatternDoc()}\n\nSTRONGLY prefer selecting a pattern (free-form shell is flagged to the user). TRACTABILITY: a gate must be satisfiable by ONE cheap attempt from a fresh checkout using the AVAILABLE TOOLS in the survey. Do NOT emit a project-wide e2e SUITE ("npm run test:e2e"/"npm run e2e", a cypress run) or a project-wide npm script that may not exist. But a UI node's BEHAVIOR must be gated with TEETH, not a "grep for a class name" stub. For anything the user must SEE happen (a value updates on a click, a card flips on reveal, a control disables off-turn), PREFER a SINGLE-FILE PLAYWRIGHT behavioral spec: gate it as "npx playwright test <one .spec.ts>" and have the build write that one spec to drive the page and assert the [data-testid=...]/[data-action=...] behaviors the CONTRACT pins (the harness installs playwright + chromium on demand). ONE focused spec per node — never a whole suite. (The zero-dep "dom-behavior" pattern is an alternative when a browser is present but playwright is not.) Reserve "npm run build --if-present" + grep ONLY for "the page renders at all"; for logic/data use a unit test or node -e assertion. Output ONLY JSON: {"gates":[{node,pattern,params} | {node,freeform}]}.`;
    const inferUser = `NODES:\n${needsInference.map((n) => `${n.id}: ${n.brief}`).join("\n")}\n\nREPOSITORY SURVEY (use REAL commands found here):\n${survey}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const inferred = await jsonStage(
        llm,
        model,
        attempt === 0 ? "infer-gates" : "infer-gates:repair",
        inferSystem,
        attempt === 0
          ? inferUser
          : `${inferUser}\n\nYour previous gate selection could not be rendered. Fix the issues below and return corrected gates only.\n${freeformGates.map((f) => `- ${f.node}: ${f.run}`).join("\n")}`,
        InferGatesSchema,
        usage,
      );
      freeformGates.length = 0;
      for (const node of needsInference) gatesByNode.delete(node.id);
      for (const g of inferred.gates) {
        if (!needsInference.some((n) => n.id === g.node)) continue;
        if (g.pattern) {
          try {
            gatesByNode.set(g.node, renderGate(g.pattern, g.params));
          } catch (err) {
            freeformGates.push({ node: g.node, run: (err as Error).message });
          }
        } else if (g.freeform) {
          gatesByNode.set(g.node, GateSchema.parse({ type: "command", run: g.freeform, soft: false }));
          freeformGates.push({ node: g.node, run: g.freeform });
        }
      }
      const ungated = needsInference.filter((n) => !gatesByNode.has(n.id)).map((n) => n.id);
      if (ungated.length === 0 && freeformGates.every((f) => !/^pattern /.test(f.run))) break;
      if (attempt === 1) {
        return {
          ok: false,
          reasons: [`no objective gate could be inferred for node(s): ${ungated.join(", ") || needsInference.map((n) => n.id).join(", ")}`],
          remediations: ungated.length > 0 ? ungated.map((node) => remediationFor(node)) : needsInference.map((n) => remediationFor(n.id)),
        };
      }
    }
    const ungated = needsInference.filter((n) => !gatesByNode.has(n.id)).map((n) => n.id);
    if (ungated.length > 0) {
      return {
        ok: false,
        reasons: [`no objective gate could be inferred for node(s): ${ungated.join(", ")}`],
        remediations: ungated.map((node) => remediationFor(node)),
      };
    }
  }

  // Fold the concrete acceptance commands of a mixed-tier node onto its inferred
  // gate, so a node that bundles auto-anchored requirements WITH inference-needing
  // ones still verifies all of them (the aggregate-gate property).
  for (const [id, cmds] of concreteExtra) {
    const g = gatesByNode.get(id);
    if (g && (g.type === "command" || g.type === "metric") && g.run) {
      gatesByNode.set(id, GateSchema.parse({ type: "command", run: [g.run, ...cmds].join(" && "), soft: false }));
    }
  }

  // Ground every gate (spec-authored OR inferred) in tools that exist: bare
  // `python`/`pip` → `python3`/`pip3` (127 halts), strip hallucinated test-case
  // filters (254 halts), downgrade node-level e2e to the build floor, and scaffold
  // a runnable npm skeleton so a greenfield `npm test` doesn't ENOENT (254 halts).
  // The harness owns this floor — the cheap builder can't be trusted to scaffold.
  for (const [id, g] of gatesByNode) {
    if ((g.type === "command" || g.type === "metric") && g.run) {
      gatesByNode.set(id, { ...g, run: bootstrapGreenfieldNodeGate(tractableGateRun(g.run)) });
    }
  }

  // 3d. PROOFREAD gate satisfiability — catch a gate that READS state it never seeds (an
  // empty SELECT, a login as a user nobody registers) BEFORE the build burns its whole
  // escalation ladder on an unwinnable check. Authored gates slip this even from the knight
  // (measured across the trustysquire probe). Repair once via the planner (seed through the
  // build's own interface); collect anything still broken to surface in the readback.
  const gateWarnings: { node: string; issues: string[] }[] = [];
  for (const [id, g] of gatesByNode) {
    if (g.type !== "command" || !g.run) continue;
    const issues = gateProofread(g.run);
    if (issues.length === 0) continue;
    const node = decomposed.nodes.find((n) => n.id === id);
    const repaired = await repairUnsatisfiableGate(llm, model, {
      brief: node?.brief ?? "",
      contract: decomposed.contract,
      gate: g.run,
      issues,
    });
    if (repaired && gateProofread(repaired).length === 0) {
      gatesByNode.set(id, { ...g, run: repaired });
    } else {
      gateWarnings.push({ node: id, issues });
    }
  }

  // 3b. Harness-ATTACH a deterministic DOM presence gate. The planner won't SELECT
  // dom-behavior (measured 4×); rather than coax it, we derive the gate from the DOM
  // contract the build conforms to and attach it to the LAST UI node — the one that
  // assembles the most complete surface — so the served app must render every pinned
  // hook. Real exit-code UI teeth, no VLM, no reliance on the model's gate choice.
  // (v1: whole-app check on the final UI node; per-node hook scoping is a follow-on.)
  const uiNodes = decomposed.nodes.filter(looksLikeUi);
  if (uiNodes.length > 0) {
    const target = uiNodes[uiNodes.length - 1]!;
    const uiGate = deriveUiGate(target, decomposed.contract);
    if (uiGate) gatesByNode.set(target.id, uiGate);
  }

  // 3c. Harness-BOOT any HTTP gate that curls a localhost server it never starts. The
  // planner writes `curl localhost:8000/...` with no boot step, so the gate is
  // un-passable by construction (connection refused) regardless of the built code — the
  // trustysquire build honest-halted on exactly this. Same fix as the DOM gate's
  // `--serve`, generalized to API gates: wrap so the harness boots the server, waits for
  // the port, runs the curls, tears down. (DOM gates already serve-wrap → skipped here.)
  for (const [id, g] of gatesByNode) {
    if (g.type !== "command" || !g.run) continue;
    const port = serverGatePort(g.run);
    if (port !== null) gatesByNode.set(id, { ...g, run: wrapWithServeGate(g.run, port) });
  }

  // 4. extract-claims (incl. implicit assumptions)
  const extracted = await jsonStage(
    llm,
    model,
    "extract-claims",
    'You decompile a plan into the falsifiable claims it rests on. Include IMPLICIT assumptions: what unstated premise would make this plan fail? Mark loadBearing=true when the plan collapses if the claim is false. EVERY claim must be about whether THE PRODUCT CAN BE BUILT and pass its acceptance gates — a prediction about the implementation, its feasibility, its budget, or its data. NEVER emit meta-claims about the spec text itself (e.g. "the requirements mention components/modules", "the spec describes X", "the brief contains Y"): whether a word appears in the requirements is not a buildability fact, and a downstream adversary will waste a refutation on it. If a claim\'s truth turns on the SPEC\'S WORDING rather than the BUILD\'S FEASIBILITY, drop it. Output ONLY JSON: {"claims":[{id,statement,loadBearing,about}]}.',
    `${intent}\n\nPLAN NODES:\n${decomposed.nodes.map((n) => `${n.id}: ${n.brief}`).join("\n")}`,
    ClaimsSchema,
    usage,
  );

  // 5. adversarial review — load-bearing claims only; evidence-free refutations discarded
  const verdicts: ClaimVerdict[] = [];
  for (const claim of extracted.claims) {
    const verdict: ClaimVerdict = { ...claim, lenses: [], refuted: false };
    if (claim.loadBearing) {
      for (const lens of LENSES) {
        // The adversary is a best-effort QUALITY gate, not a required stage. If it flakes
        // (bad JSON twice), FAIL OPEN — treat as "not refuted" so a mute adversary never
        // halts the build. Only a competent, evidence-backed refutation blocks.
        let res: z.infer<typeof LensSchema>;
        try {
          res = await jsonStage(
            llm,
            judgeModel ?? model,
            `lens:${lens.id}`,
            `${lens.instruction} Output ONLY JSON: {"refuted": boolean, "evidence": "shown arithmetic or named sources — REQUIRED when refuted"}.`,
            `CLAIM: ${claim.statement}\nCONTEXT: ${claim.about}`,
            LensSchema,
            usage,
          );
        } catch {
          res = { refuted: false, evidence: "" };
        }
        // Discard a refutation that is evidence-free OR whose evidence actually
        // affirms buildability (the model reversed the polarity). Only an
        // accountable, genuinely-infeasible refutation blocks the build.
        const discarded = res.refuted && (res.evidence.trim().length < 10 || affirmsBuildability(res.evidence));
        verdict.lenses.push({ lens: lens.id, refuted: res.refuted, evidence: res.evidence, discarded });
        if (res.refuted && !discarded) verdict.refuted = true;
      }
    }
    verdicts.push(verdict);
  }
  const refuted = verdicts.filter((v) => v.refuted);
  const refutationOf = (v: ClaimVerdict): string =>
    v.lenses
      .filter((l) => l.refuted && !l.discarded)
      .map((l) => `[${l.lens}] ${l.evidence}`)
      .join("; ");
  // 5b. remedy — don't dead-halt on a refutation that has an obvious fix. Mirror the
  // audit→rebuild loop: for each refuted claim, decide whether it is impossible IN
  // PRINCIPLE (no implementation could satisfy it → honest halt) or merely infeasible
  // AS STATED but buildable with an obvious constraint (restrict inputs, filter edge
  // cases, relax a universal to a guarded guarantee — e.g. "only surface arbs whose
  // margin exceeds the cent-rounding error"). Remediable refutations FOLD a build
  // constraint into every node brief and the plan proceeds; only the genuinely
  // impossible still halts. The reviewer's rigor is intact — its verdict now drives a
  // spec revision instead of a wall.
  let foldedConstraints: string[] = [];
  if (refuted.length > 0) {
    const refutationText = refuted.map((v) => `CLAIM: ${v.statement}\nREFUTATION: ${refutationOf(v)}`).join("\n\n");
    let remedy: z.infer<typeof RemedySchema>;
    try {
      remedy = await jsonStage(
        llm,
        judgeModel ?? model,
        "remedy",
        'A feasibility reviewer refuted load-bearing claims with proofs. For EACH claim decide: is it impossible IN PRINCIPLE (no implementation could satisfy it, even after reasonable input restrictions or filtering edge cases), or merely infeasible AS STATED but buildable with an obvious constraint (restrict inputs, filter edge cases, relax a universal guarantee to a guarded one)? If remediable, write ONE imperative build-constraint sentence stating what the implementation must do to resolve it. If impossible in principle, set remediable=false and leave constraint empty. Output ONLY JSON: {"remedies":[{"claim":"<verbatim claim text>","remediable":boolean,"constraint":"<one imperative sentence>"}]}.',
        refutationText,
        RemedySchema,
        usage,
      );
    } catch {
      remedy = { remedies: [] };
    }
    const byClaim = new Map(remedy.remedies.map((r) => [r.claim.trim(), r]));
    const remedyFor = (v: ClaimVerdict): z.infer<typeof RemedySchema>["remedies"][number] | undefined =>
      byClaim.get(v.statement.trim()) ?? remedy.remedies.find((r) => r.claim.includes(v.statement.slice(0, 24)));
    const unremediable = refuted.filter((v) => {
      const r = remedyFor(v);
      return !r || !r.remediable || !r.constraint.trim();
    });
    if (unremediable.length > 0) {
      // Genuinely impossible (or the remedy stage couldn't produce a fix): honest halt.
      return {
        ok: false,
        reasons: unremediable.map((v) => `load-bearing claim refuted, no buildable remedy: "${v.statement}" — ${refutationOf(v)}`),
        remediations: [],
      };
    }
    foldedConstraints = refuted.map((v) => remedyFor(v)!.constraint.trim()).filter((c, i, a) => c && a.indexOf(c) === i);
  }

  // 6. compile + validate. Fold any remediable-refutation constraints into every
  // node brief so the executor actually implements the fix (the executor sees only
  // its brief + packed files, so the constraint must live there).
  const constraintBlock =
    foldedConstraints.length > 0
      ? `\n\nBUILD CONSTRAINTS (resolve feasibility issues the plan review found — you MUST implement these):\n${foldedConstraints.map((c) => `- ${c}`).join("\n")}`
      : "";
  // Prepend the shared contract so every node builds to the SAME data shapes and
  // module signatures — the executor sees only its brief, so the shared interface
  // must live there or nodes drift into incompatible schemas.
  const contractBlock = decomposed.contract.trim()
    ? `SHARED CONTRACT (the whole build conforms to these data shapes + module signatures — do not invent your own):\n${decomposed.contract.trim()}\n\n---\n\n`
    : "";
  // Per-node USD: floor + escalation reserve over the planner's weights (step 2).
  const nodeBudgets = allocateNodeBudgets(
    decomposed.nodes.map((n) => n.budget_usd),
    input.budgetUsd,
  );
  const missionObj = {
    goal: input.spec ? input.spec.thesis : input.goal!,
    budget_usd: input.budgetUsd,
    chain: input.chainName,
    workdir: ".",
    max_human_checks: input.maxHumanChecks ?? 3,
    nodes: decomposed.nodes.map((n, i) => {
      const gate = gatesByNode.get(n.id)!;
      // A node verified by a live serve-gate needs a runnable, listening server — the
      // shared contract may have pinned a non-listening factory (the auth-api incoherence).
      const servePort = gate.type === "command" && gate.run ? gate.run.match(/serve-gate\.mjs --port (\d+)/)?.[1] : undefined;
      const serveNote = servePort ? `\n\n${serveGateBriefNote(Number(servePort))}` : "";
      return {
        id: n.id,
        brief: contractBlock + n.brief + serveNote + constraintBlock,
        deps: n.deps,
        context_globs: n.context_globs,
        blast_radius: n.blast_radius,
        gate,
        budget_usd: nodeBudgets[i]!,
        // Size every node to the EXECUTOR's envelope (replaces the "1-12" count anchor):
        // the planner sized the work to it; the runtime pack must honour the same bound.
        max_context_tokens: envelopeTokens,
      };
    }),
  };
  const mission = MissionSchema.safeParse(missionObj);
  if (!mission.success) {
    return { ok: false, reasons: [`compiled mission invalid:\n${formatZodIssues(mission.error.issues)}`], remediations: [] };
  }

  // 7. readback
  const proofreadNote =
    gateWarnings.length > 0
      ? `\n\n⚠ gate proofreader could not repair ${gateWarnings.length} unsatisfiable gate(s) — these will halt the build honestly:\n` +
        gateWarnings.map((w) => `  - ${w.node}: ${w.issues.join("; ")}`).join("\n")
      : "";
  const readback = renderReadback(mission.data, verdicts, freeformGates, foldedConstraints) + proofreadNote;
  return {
    ok: true,
    mission: mission.data,
    claims: verdicts,
    freeformGates,
    readback,
    inTokens: usage.in,
    outTokens: usage.out,
    ...(usage.reportedCalls > 0 ? { costUsd: usage.costUsd } : {}),
  };
}

export function buildDirectMission(input: DirectMissionInput): Mission {
  if (input.items.length === 0) {
    throw new SquireError("SPEC_FAST_PATH_INVALID", "direct mission requires at least one item");
  }
  const budgetPerNode = Math.max(0.01, Number((input.budgetUsd / input.items.length).toFixed(2)));
  const prefix = input.idPrefix ?? "d";
  const nodes = input.items.map((item, index) => {
    const gate = acceptanceToGate(item.acceptance ?? { tier: 1, gate: "npm test -- --run" });
    const nodeId = `${prefix}${index + 1}`;
    return {
      id: nodeId,
      brief: item.statement,
      deps: index === 0 ? [] : [`${prefix}${index}`],
      context_globs: ["**/*"],
      blast_radius: ["**/*"],
      gate,
      budget_usd: budgetPerNode,
    };
  });
  return MissionSchema.parse({
    goal: input.thesis,
    budget_usd: input.budgetUsd,
    chain: input.chainName,
    workdir: ".",
    max_human_checks: input.maxHumanChecks ?? 3,
    nodes,
  });
}

function acceptanceToGate(acceptance: Spec["requirements"][number]["acceptance"]): Gate {
  if (acceptance.tier === 4) return GateSchema.parse({ type: "human", artifact: acceptance.artifact!, soft: false });
  if (acceptance.tier >= 1 && acceptance.tier <= 2) {
    // greenfield/rebuild path: bootstrap deps for non-e2e gates; e2e downgrades to
    // the (already dep-installing) build floor.
    const grounded = groundGateRun(acceptance.gate!);
    const run = E2E_GATE.test(grounded) ? E2E_BUILD_FLOOR : bootstrapGreenfieldNodeGate(grounded);
    return GateSchema.parse({ type: acceptance.tier === 1 ? "command" : "metric", run, soft: false });
  }
  if (acceptance.tier === 3) {
    return GateSchema.parse({
      type: "judge",
      artifact: acceptance.artifact ?? "build/**",
      soft: true,
      judge: { model: "pinned", rubric: acceptance.gate ?? "manual rubric", votes: 3 },
    });
  }
  throw new SquireError("SPEC_FAST_PATH_INVALID", `cannot fast-path unanchored acceptance tier ${acceptance.tier}`);
}

/**
 * Make a greenfield npm gate runnable. The cheap builder writes source + tests but
 * cannot be trusted to scaffold the project skeleton — and a node in an empty repo
 * runs `npm test` against no package.json, which exits ENOENT (254) before a single
 * test runs and halts the build for a non-reason (the clairvoyance N1 halt). The
 * HARNESS owns this floor deterministically:
 *   1. if no package.json, write a minimal vite+vitest skeleton (so `npm test` →
 *      `vitest run` and `npm run build` → `vite build` resolve). Idempotent — the
 *      `[ ! -f package.json ]` guard never clobbers a real project a node set up
 *      (Next.js, an existing manifest, etc.).
 *   2. ensure a test runner is actually installed (greenfield skeletons have none).
 *   3. install deps if absent; install the browser harness only for e2e gates.
 *   4. for a BUILD gate, ensure a vite entry exists: `vite build` on an early node
 *      that hasn't written the UI shell yet dies with "Could not resolve entry
 *      module index.html" (the clairvoyance N2 halt). A minimal bare index.html lets
 *      the build resolve; later UI nodes overwrite it and the visual audit keeps the
 *      real UI teeth. Only for build gates — pure test nodes don't need (or want) it.
 * The JSON/HTML are single-quote-free so they survive the sh -c re-quoting cleanly.
 */
export function bootstrapGreenfieldNodeGate(run: string): string {
  if (!/\bnpm (test|run)\b/.test(run)) return run;
  const skeleton = '{"name":"app","private":true,"type":"module","scripts":{"test":"vitest run","build":"vite build"}}';
  // A vitest config that runs the whole UNIT suite but excludes e2e/playwright specs
  // (.spec.* + anything under e2e/) — without it, `npm test` collects the model's
  // playwright specs and dies importing @playwright/test. Double-quoted only, so it
  // survives the sh -c single-quote re-quoting.
  const vitestConfig =
    'import { defineConfig, configDefaults } from "vitest/config"; export default defineConfig({ test: { exclude: [...configDefaults.exclude, "**/e2e/**", "**/*.spec.*"] } });';
  const indexHtml =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>app</title></head><body><div id="app"></div></body></html>';
  const isBuildGate = /\bnpm run build\b|\bvite build\b/.test(run);
  const bootstrap = [
    `if [ ! -f package.json ]; then printf '%s' '${skeleton}' > package.json; fi`,
    `if [ ! -f vitest.config.js ] && [ ! -f vitest.config.ts ]; then printf '%s' '${vitestConfig}' > vitest.config.js; fi`,
    ...(isBuildGate ? [`if [ ! -f index.html ]; then printf '%s' '${indexHtml}' > index.html; fi`] : []),
    "if [ ! -x node_modules/.bin/vitest ] && grep -q vitest package.json; then npm install --no-fund --no-audit -D vitest vite >/dev/null 2>&1; fi",
    "if [ ! -d node_modules ]; then npm install --no-fund --no-audit; fi",
    `if printf '%s' ${shellQuoteForCommand(run)} | grep -Eq 'playwright|test:e2e'; then npm install --no-fund --no-audit -D @playwright/test >/dev/null 2>&1; npx playwright install chromium >/dev/null 2>&1 || npx playwright install >/dev/null 2>&1; fi`,
    run,
  ].join(" && ");
  return `sh -c ${shellQuoteForCommand(bootstrap)}`;
}

/** Judge mode: can this spec compile? Diagnostics, no mission emitted (SPEC-v0.2 §6.2). */
export function specPreGate(spec: Spec): DeriveRefusal | null {
  const reasons: string[] = [];
  const remediations: DeriveRefusal["remediations"] = [];
  for (const r of unanchoredRequirements(spec)) {
    reasons.push(`requirement ${r} is UNANCHORED (tier 0) — no objective check`);
    remediations.push(remediationFor(r));
  }
  for (const d of refutedDecisions(spec)) {
    reasons.push(`decision ${d} rests on a REFUTED claim — revise before compiling`);
  }
  for (const q of blockingQuestions(spec)) {
    reasons.push(`open question ${q} is blocking`);
  }
  return reasons.length > 0 ? { ok: false, reasons, remediations } : null;
}

function remediationFor(id: string): { requirement: string; options: [string, string, string] } {
  return {
    requirement: id,
    options: [
      `anchor: supply reference artifacts -> tier-2 metric gate`,
      `proxy: accept a tier-1 conformance battery (catches defects, not quality)`,
      `own: insert a tier-4 human checkpoint (counted against max_human_checks)`,
    ],
  };
}

function shellQuoteForCommand(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function renderReadback(
  mission: Mission,
  claims: ClaimVerdict[],
  freeform: { node: string; run: string }[],
  foldedConstraints: string[] = [],
): string {
  const lines: string[] = [];
  lines.push(`plan: ${mission.nodes.length} node(s), budget $${mission.budget_usd}, chain ${mission.chain}`);
  const humanCount = mission.nodes.filter((n) => n.gate?.type === "human").length;
  for (const n of mission.nodes) {
    const g = n.gate!;
    lines.push(`  ${n.id}  [${g.type}] ${g.run ?? g.artifact ?? ""}  radius: ${n.blast_radius.join(",")}  $${n.budget_usd}`);
  }
  lines.push(`human checkpoints: ${humanCount} (~${humanCount} min of your judgment)`);
  const loadBearing = claims.filter((c) => c.loadBearing);
  for (const c of loadBearing) {
    lines.push(`  claim "${c.statement.slice(0, 60)}": survived ${c.lenses.filter((l) => !l.refuted).length}/${c.lenses.length} lenses`);
  }
  for (const c of foldedConstraints) {
    lines.push(`  ↻ feasibility review refuted a claim; folded a build constraint instead of halting: ${c}`);
  }
  for (const f of freeform) {
    lines.push(`  ⚠ free-form gate on ${f.node} (no library pattern): ${f.run}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI wiring: ser derive <goal | path/to/x.spec.yaml> [--judge] [--out <file>]
// ---------------------------------------------------------------------------

export async function runDeriveV2(args: string[]): Promise<number> {
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const { resolve, join } = await import("node:path");
  const { stringify } = await import("yaml");
  const { parseSpec } = await import("./spec.js");
  const { loadChainsForDerive } = await import("./derive.js");
  const { resolveChain } = await import("./schema.js");

  const positional: string[] = [];
  const value = new Map<string, string>();
  const bool = new Set<string>();
  const valued = ["chain", "chains", "budget", "out", "workdir"];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (valued.includes(name)) value.set(name, args[++i] ?? "");
      else bool.add(name);
    } else positional.push(a);
  }
  const target = positional[0];
  if (!target) throw new SquireError("USAGE", 'ser derive <goal | spec.yaml> [--judge] [--out <file>]');

  const workdir = resolve(value.get("workdir") ?? process.cwd());
  const chainName = value.get("chain") ?? "cheap";
  const chains = loadChainsForDerive(workdir, value.get("chains"));
  const chain = resolveChain(chains, chainName);

  // Detect a spec by CONTENT, not just the `.spec.yaml` extension: the TUI writes
  // its spec to `.ser/spec.yaml`, and naming it differently must NOT silently turn
  // the spec file's PATH into the build "goal" (which yields a nonsense "read this
  // yaml and build something" mission). Any existing YAML file that parses as a spec
  // is treated as a spec; anything else is a free-text goal.
  let spec: ReturnType<typeof parseSpec> | undefined;
  const asPath = resolve(target);
  if (/\.ya?ml$/.test(target) && existsSync(asPath)) {
    try { spec = parseSpec(readFileSync(asPath, "utf8"), target); } catch { spec = undefined; }
  }

  // Judge mode: mechanical pre-gates only — no tokens, exit code is the verdict.
  if (bool.has("judge")) {
    if (!spec) throw new SquireError("USAGE", "--judge requires a .spec.yaml input");
    const refusal = specPreGate(spec);
    if (refusal) {
      for (const r of refusal.reasons) process.stdout.write(`error: ${r}\n`);
      for (const rem of refusal.remediations) {
        process.stdout.write(`  ${rem.requirement}: choose one —\n`);
        for (const o of rem.options) process.stdout.write(`    (${o})\n`);
      }
      return 1;
    }
    process.stdout.write("spec pre-gates: OK (full compile check requires the pipeline; run without --judge)\n");
    return 0;
  }

  const { makeLlmClient } = await import("../backend.js");
  const llm = await makeLlmClient();

  const result = await deriveV2({
    goal: spec ? undefined : target,
    spec,
    workdir,
    llm,
    // Authoring (decompose/infer-gates/extract-claims/adversary) is premium — a cheap model
    // is an unreliable planner AND an incompetent adversary. The emitted mission still BUILDS
    // on the cheap chain (chainName) — premium authoring, cheap build loop (the thesis).
    model: chain.knight,
    judgeModel: chain.knight,
    chainName,
    budgetUsd: Number(value.get("budget") ?? "2.5"),
    // Size nodes to the RUNTIME executor's envelope, not the knight that plans them.
    executorModel: chain.executor,
    nodeContextBudget: chain.node_context_budget,
  });

  if (!result.ok) {
    for (const r of result.reasons) process.stdout.write(`refused: ${r}\n`);
    for (const rem of result.remediations) {
      process.stdout.write(`  ${rem.requirement}: choose one —\n`);
      for (const o of rem.options) process.stdout.write(`    (${o})\n`);
    }
    return 1;
  }

  const outPath = resolve(value.get("out") ?? join(workdir, "mission.yaml"));
  writeFileSync(outPath, stringify(result.mission));
  process.stdout.write(result.readback + `\nwritten: ${outPath}\n`);
  if (!bool.has("yes")) process.stdout.write("review the plan, then: ser run " + outPath + "\n");
  return 0;
}
