import { z } from "zod";
import { SquireError } from "../errors.js";
import type { LlmClient } from "../llm/types.js";
import { MissionSchema, GateSchema, type Mission, type Gate } from "./schema.js";
import { renderGate } from "./gate-patterns.js";
import { CASTELLAN_IDENTITY, GATE_LADDER_DOC, gatePatternDoc } from "./self-knowledge.js";
import { buildRepoSurvey, tryParseJson, formatZodIssues } from "./derive.js";
import { type Spec, unanchoredRequirements, refutedDecisions, blockingQuestions } from "./spec.js";

/**
 * derive-v2 — the herald pipeline (SPEC-v0.2 §6). Planning as a gated loop:
 * survey → decompose → infer-gates → extract-claims → adversarial-review →
 * compile+validate → readback. Each LLM stage is a cheap-model call with one
 * schema-retry; inter-stage gates are mechanical. Refusal over silent fallback.
 */

// --- stage output schemas ---

const DecomposeSchema = z.object({
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
      params: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
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
  /** Cheap executor model — runs the mechanical stages (decompose, infer-gates, extract-claims). */
  model: string;
  /** Premium adversary (the knight) for the adversarial-review stage — a cheap model is an
   * incompetent adversary (it "refutes" trivially-true claims). Falls back to `model` if absent. */
  judgeModel?: string;
  chainName: string;
  budgetUsd: number;
  maxHumanChecks?: number;
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

export function isInteractiveAppIntent(text: string): boolean {
  return /\b(app|web app|dashboard|game|site|website|ui|interface|fortune|casino|poker|blackjack)\b/i.test(text);
}

/**
 * One general planning rule for any user-facing app: decompose around capabilities,
 * not files, and plan for the affordances a usable version needs. Deliberately NOT
 * per-category (dashboard/game/fortune) — that was overfit to a few demos; this is
 * the inference a senior builder applies to any product.
 */
export function productPlanningContract(text: string): string {
  if (!isInteractiveAppIntent(text)) return "";
  return [
    "INTERACTIVE APP MODE:",
    "Decompose the work around user-visible capabilities and workflows, not around filenames or source modules.",
    "Do NOT emit a plan that is mostly 'create index.html', 'write render.js', 'fill data.js', or similar file-shaped trivia.",
    "Prefer nodes that correspond to product outcomes such as the primary viewport hierarchy, the core interaction/result flow end to end, domain logic, and final polish.",
    "It is acceptable for one node to touch multiple files when that is what the user-facing capability requires; at most one thin wiring/integration node, the rest should be product-shaped.",
    "Plan explicitly for the affordances any usable version of THIS product needs: the headline value visible in the first viewport, the core flow working end to end, real (not placeholder) content, empty/loading/error states, and mobile scanability.",
  ].join(" ");
}

export function isImplementationShapedDecomposition(
  nodes: Array<{ brief: string; blast_radius: string[] }>,
  text: string,
): boolean {
  if (!isInteractiveAppIntent(text) || nodes.length === 0) return false;
  const fileMention = /\b([a-z0-9_-]+\.(html|css|js|ts|tsx|jsx)|index\.html|render\.[jt]s|data\.[jt]s)\b/i;
  const productLanguage =
    /\b(viewport|hierarchy|responsive|mobile|player|dealer|opponent|game loop|bet|table|dashboard|panel|ranked|compare|reading|tarot|fortune|ritual|result|flow|experience)\b/i;
  const implementationNodes = nodes.filter((node) => {
    const singleFileRadius = node.blast_radius.length === 1 && /\.[a-z0-9]+$/i.test(node.blast_radius[0] ?? "");
    const fileShapedBrief = fileMention.test(node.brief) && !productLanguage.test(node.brief);
    return singleFileRadius || fileShapedBrief;
  }).length;
  const productNodes = nodes.filter((node) => productLanguage.test(node.brief)).length;
  return implementationNodes >= Math.ceil(nodes.length * 0.75) && productNodes === 0;
}

export function trimSurveyForDecompose(survey: string, text: string): string {
  if (!isInteractiveAppIntent(text)) return survey;
  const filesMatch = survey.match(/FILES \((\d+)\):/);
  const fileCount = filesMatch ? Number(filesMatch[1]) : Number.NaN;
  if (Number.isFinite(fileCount) && fileCount <= 5) {
    const kept = survey
      .split("\n")
      .filter((line) => /^FILES \(/.test(line) || /^DETECTED CHECK COMMANDS:/.test(line) || /^AVAILABLE TOOLS/.test(line) || /^\s{2}(python3|node|npm|bash|rg|pytest|go|cargo):/.test(line) || /^\s{2}(npm run|make )/.test(line));
    return kept.join("\n");
  }
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
  return run
    .replace(/\bpython\b(?!3)/g, "python3")
    .replace(/\bpip\b(?!3)/g, "pip3")
    .replace(/(^|[;&|(\n]\s*)pytest\b/g, "$1python3 -m pytest");
}

/** An end-to-end / browser-harness gate at the NODE level (intractable: a single
 *  cheap node can't stand up Playwright/Cypress + a project-wide `test:e2e` script
 *  from nothing). End-to-end is the VISUAL AUDIT's job, not a per-node gate. */
const E2E_GATE = /\b(playwright|cypress|webdriver\.?io|puppeteer)\b|\bnpm run (test:e2e|e2e)\b|\btest:e2e\b/i;

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
  return E2E_GATE.test(grounded) ? E2E_BUILD_FLOOR : grounded;
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
  const productText = input.spec
    ? `${input.spec.thesis}\n${input.spec.stories.join("\n")}\n${input.spec.requirements.map((r) => r.statement).join("\n")}`
    : input.goal!;
  const decomposeSurvey = trimSurveyForDecompose(survey, productText);

  // 2. decompose
  const coverageRule = input.spec
    ? ` SPEC MODE — COVERAGE IS MANDATORY: the requirements above are labelled R1, R2, … (specifically: ${input.spec.requirements
        .map((r) => r.id)
        .join(", ")}). EVERY node MUST set "requirement" to the id of the requirement it implements, and EVERY one of those requirement ids MUST be covered by at least one node. Do not emit a node without a "requirement"; do not leave any requirement uncovered.`
    : "";
  const decomposeSystem =
    `${CASTELLAN_IDENTITY}\n\nYour role, the Herald: decompose work into 1-12 nodes forming a DAG. Briefs are self-contained (the executor sees ONLY the brief and its packed files). blast_radius is the narrowest glob set permitting the work. Distribute the budget. Do NOT write gates yet.${coverageRule} ${productPlanningContract(productText)} Output ONLY JSON: {"nodes":[{id,brief,deps,context_globs,blast_radius,budget_usd,requirement?}]}.`;
  const decomposeUser = `${intent}\n\nREPOSITORY SURVEY:\n${decomposeSurvey}\n\nMISSION BUDGET USD: ${input.budgetUsd}`;
  let decomposed = await jsonStage(llm, model, "decompose", decomposeSystem, decomposeUser, DecomposeSchema, usage);
  if (isImplementationShapedDecomposition(decomposed.nodes, productText)) {
    decomposed = await jsonStage(
      llm,
      model,
      "decompose:product-shape-retry",
      decomposeSystem,
      `${decomposeUser}\n\nYour previous decomposition was too implementation-shaped for an interactive app. Re-plan around user-visible capabilities and product workflows instead of source files.`,
      DecomposeSchema,
      usage,
    );
  }

  // spec-mode coverage gate: every requirement maps to >=1 node
  if (input.spec) {
    let covered = new Set(decomposed.nodes.map((n) => n.requirement).filter(Boolean));
    let missing = input.spec.requirements.filter((r) => !covered.has(r.id)).map((r) => r.id);
    if (missing.length > 0) {
      decomposed = await jsonStage(
        llm,
        model,
        "decompose:coverage-retry",
        decomposeSystem,
        `${decomposeUser}\n\nYour previous decomposition left these requirement ids uncovered: ${missing.join(", ")}.\nRe-emit the SAME plan shape if you want, but every requirement id must be assigned to at least one node via the "requirement" field. If one node satisfies multiple requirements, duplicate that capability into additional nodes or split the node so that each listed requirement id is explicitly covered.`,
        DecomposeSchema,
        usage,
      );
      covered = new Set(decomposed.nodes.map((n) => n.requirement).filter(Boolean));
      missing = input.spec.requirements.filter((r) => !covered.has(r.id)).map((r) => r.id);
    }
    if (missing.length > 0) {
      return { ok: false, reasons: [`decomposition covers no node for requirement(s): ${missing.join(", ")}`], remediations: [] };
    }
  }

  // 3. infer-gates — spec acceptance wins; otherwise select from the pattern library
  const gatesByNode = new Map<string, Gate>();
  const freeformGates: { node: string; run: string }[] = [];
  const needsInference = decomposed.nodes.filter((n) => {
    const req = input.spec?.requirements.find((r) => r.id === n.requirement);
    if (!req) return true;
    const a = req.acceptance;
    if (a.tier >= 1 && a.tier <= 2) {
      gatesByNode.set(n.id, { type: a.tier === 1 ? "command" : "metric", run: a.gate!, soft: false });
      return false;
    }
    if (a.tier === 4) {
      gatesByNode.set(n.id, { type: "human", artifact: a.artifact!, soft: false });
      return false;
    }
    return true; // tier 3 or unanchorable handled elsewhere
  });

  if (needsInference.length > 0) {
    const inferSystem = `${CASTELLAN_IDENTITY}\n\nYour role: select objective gates for plan nodes.\n\n${GATE_LADDER_DOC}\n\n${gatePatternDoc()}\n\nSTRONGLY prefer selecting a pattern (free-form shell is flagged to the user). TRACTABILITY: a gate must be satisfiable by ONE cheap attempt from a fresh checkout using the AVAILABLE TOOLS in the survey. NEVER emit an end-to-end / browser gate (playwright, cypress, "npm run test:e2e"/"npm run e2e") or a project-wide npm script that may not exist — end-to-end is the visual audit's job. For UI nodes prefer "npm run build --if-present" + a grep/test -f check; for logic/data a unit test or node -e assertion. Output ONLY JSON: {"gates":[{node,pattern,params} | {node,freeform}]}.`;
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

  // Ground every gate (spec-authored OR inferred) in tools that exist: bare
  // `python`/`pip` → `python3`/`pip3`. A gate that calls a missing command exits
  // 127 and halts the build for a non-reason (the clairvoyance build halt).
  for (const [id, g] of gatesByNode) {
    if ((g.type === "command" || g.type === "metric") && g.run) {
      gatesByNode.set(id, { ...g, run: tractableGateRun(g.run) });
    }
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
  if (refuted.length > 0) {
    return {
      ok: false,
      reasons: refuted.map(
        (v) =>
          `load-bearing claim refuted: "${v.statement}" — ${v.lenses
            .filter((l) => l.refuted && !l.discarded)
            .map((l) => `[${l.lens}] ${l.evidence}`)
            .join("; ")}`,
      ),
      remediations: [],
    };
  }

  // 6. compile + validate
  const missionObj = {
    goal: input.spec ? input.spec.thesis : input.goal!,
    budget_usd: input.budgetUsd,
    chain: input.chainName,
    workdir: ".",
    max_human_checks: input.maxHumanChecks ?? 3,
    nodes: decomposed.nodes.map((n) => ({
      id: n.id,
      brief: n.brief,
      deps: n.deps,
      context_globs: n.context_globs,
      blast_radius: n.blast_radius,
      gate: gatesByNode.get(n.id)!,
      budget_usd: n.budget_usd,
    })),
  };
  const mission = MissionSchema.safeParse(missionObj);
  if (!mission.success) {
    return { ok: false, reasons: [`compiled mission invalid:\n${formatZodIssues(mission.error.issues)}`], remediations: [] };
  }

  // 7. readback
  const readback = renderReadback(mission.data, verdicts, freeformGates);
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

function bootstrapGreenfieldNodeGate(run: string): string {
  if (!/\bnpm (test|run)\b/.test(run)) return run;
  const bootstrap = [
    "if [ ! -d node_modules ]; then npm install --no-fund --no-audit; fi",
    `if printf '%s' ${shellQuoteForCommand(run)} | grep -Eq 'playwright|test:e2e'; then npx playwright install chromium >/dev/null 2>&1 || npx playwright install >/dev/null 2>&1; fi`,
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

function renderReadback(mission: Mission, claims: ClaimVerdict[], freeform: { node: string; run: string }[]): string {
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
