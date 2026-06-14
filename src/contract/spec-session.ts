import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, basename } from "node:path";
import { execa } from "execa";
import { stringify as yamlStringify } from "yaml";
import { SquireError } from "../errors.js";
import type { LlmClient } from "../llm/types.js";
import { parseSpec, SpecSchema, unverifiedLoadBearing, type Spec } from "./spec.js";
import { specPreGate } from "./derive2.js";
import { tryParseJson, formatZodIssues } from "./derive.js";
import { CASTELLAN_IDENTITY, GATE_LADDER_DOC, SPEC_ITEM_SHAPES } from "./self-knowledge.js";

/**
 * ser spec — gated spec construction (SPEC-v0.2 §5). The spec file is the
 * ONLY state; the conversation is disposable. Each turn: user message in,
 * proposed DELTAS out (≤1 question, ≤120 words of prose). Accepted deltas
 * apply, validate, save, and git-commit (checkpointed thinking).
 */

export const DeltaSchema = z
  .object({
    section: z.enum(["thesis", "scope_fence", "requirements", "decisions", "claims", "open_questions"]),
    op: z.enum(["add", "modify", "remove", "resolve"]),
    /** Target id for modify/remove/resolve on list sections. */
    id: z.string().optional(),
    /** New value: full item object for add/modify; string for thesis/scope_fence add. */
    value: z.unknown().optional(),
    /** Set by the proposer when this delta contradicts the pinned thesis. */
    drift: z.boolean().default(false),
  })
  .strict();

export type Delta = z.infer<typeof DeltaSchema>;

/** Harness commands the mapper may REQUEST (never perform): the unified
 * interface routes these mechanically — gates judge, the model never reports. */
export const TALK_ACTIONS = ["none", "check", "verify", "derive", "run", "status", "score"] as const;

export const DeltaBatchSchema = z.object({
  deltas: z.array(DeltaSchema),
  /** At most one terse question — the highest-information open one. */
  question: z.string().default(""),
  /** The conversational answer: substantive, brutally economical (<=80 words). */
  reply: z.string().default(""),
  /** Deprecated alias kept for compat. */
  note: z.string().default(""),
  /** Requested harness command; the harness executes and reports, not the model. */
  action: z.enum(TALK_ACTIONS).default("none"),
  /** Action argument (e.g. claim id for verify). */
  action_arg: z.string().default(""),
  /** Set by the harness when this batch pivots to a NEW product (drift thesis) —
   * the stale requirements/decisions are reset rather than appended to. */
  pivot: z.boolean().default(false),
  /** The open_question id the model is surfacing this turn (e.g. "Q3"). The
   * harness remembers it so that when the user answers next turn it GUARANTEES
   * the answer is recorded — resolve + decision — even if the model forgets
   * (A37: a dropped record, not a re-ask, was the real bug). Empty if nothing
   * is asked; pure bookkeeping, never shown. */
  asking: z.string().default(""),
});

export type DeltaBatch = z.infer<typeof DeltaBatchSchema>;

/** Detect a pivot to a different product: a thesis modify flagged as drift. */
export function isPivot(deltas: Delta[]): boolean {
  return deltas.some((d) => d.section === "thesis" && d.op === "modify" && d.drift === true);
}

// A message that opens with one of these reads as a COMMAND / meta-request, not
// an answer to the question on the table — so the harness must NOT record it as
// the answer (would corrupt the spec with "present your architecture" as a value).
const META_RE =
  /^\s*(present|show|display|explain|describe|list|give|what|which|when|where|who|how|why|build|run|ship|go\b|derive|compile|deploy|check|verify|score|status|ready|undo|redo|done|stop|is (it|this|that)|are (we|you)|can you|could you|tell me|walk me|let'?s)/i;

// A message asking to SEE the plan — route to the status action, don't lock-in+ask.
const SHOW_PLAN_RE =
  /\b(architecture|user stories|the plan|the spec|the design|requirements|blueprint|show me|present|walk me through)\b/i;

/** True when a message reads like an ANSWER to a question, not a command/meta-request. */
export function isAnswerShaped(msg: string): boolean {
  return msg.trim().length > 0 && !META_RE.test(msg);
}

/** The blocking open_questions that remain after applying `deltas` to `spec`. */
export function remainingBlockingQuestions(spec: Spec, deltas: Delta[]): { id: string; text: string }[] {
  const live = new Map<string, string>();
  for (const q of spec.open_questions) if (q.blocking) live.set(q.id, q.text);
  for (const d of deltas) {
    if (d.section !== "open_questions") continue;
    if ((d.op === "resolve" || d.op === "remove") && d.id) live.delete(d.id);
    if (d.op === "add" && d.value && typeof d.value === "object") {
      const v = d.value as { id?: string; text?: string; blocking?: boolean };
      if (v.id && v.blocking !== false) live.set(v.id, v.text ?? "");
    }
  }
  return [...live].map(([id, text]) => ({ id, text }));
}

/** A clean slate for a pivot — keeps nothing; the batch's thesis + adds repopulate it. */
export function blankPivotSpec(): Spec {
  return SpecSchema.parse({
    thesis: "TODO: pivot in progress",
    stories: [],
    scope_fence: [],
    requirements: [{ id: "R1", statement: "TODO", acceptance: { tier: 0 } }],
    decisions: [],
    claims: [],
    open_questions: [],
  });
}

/** Appendix A (SPEC-v0.2) — delta-mapper instruction, draft. */
export const DELTA_MAPPER_PROMPT = `${CASTELLAN_IDENTITY}

Your role: a thought partner who is brutally economical with words, plus a
silent bookkeeper. The spec below is the ONLY state; this conversation is
disposable.

You have NO tools and cannot build, run, edit, or test anything yourself —
but you can ask the HARNESS to act by setting "action" in your output:
  check  — mechanical spec gates: is it ready to compile?
  verify — adversarial lenses on one ledger claim (action_arg: the claim id)
  derive — compile the spec into a gated mission plan
  run    — execute the mission, gate-verified commits (the harness derives
           first when the plan is stale and asks the user to confirm spend;
           below the readiness score it surfaces the gaps instead of building)
  status — spec summary + gates
  score  — readiness score + the next gap to close (auto-shown each turn)
When the user insists on building despite a low score ("build it anyway",
"just do it", "you fill it in", "figure it out yourself"), set action=run with
action_arg="auto" — the harness then autonomously fills the gaps it can and
defaults the rest before building, instead of refusing.
Set an action ONLY when the user gives an explicit imperative for that work
("build it" -> run; "is this ready?" -> check; "fact-check C2" -> verify).
DESCRIBING what they want to build ("I'd like to build X", "it should do Y")
is the GOAL — it shapes the spec, it is NOT a command to run. Do not run on a
product description; decompose and raise the forks first (below). The harness
executes and prints results — gate verdicts, commits, costs. You NEVER claim
work was performed and never report results yourself; keep the reply to intent
("running it — gates will report"). Never resolve or remove a requirement
because it is "built" — only its gate, at run time, can prove that.

For each user message output JSON:
{"reply": "...", "deltas": [...], "question": "", "asking": "", "action": "none"}

asking — the open_question id you are surfacing this turn (e.g. "Q3"), or "" if
you ask nothing. The harness remembers it: when the user answers next turn it
GUARANTEES the answer is recorded even if you forget the resolve. Pure
bookkeeping — never appears in the reply. Always set it to the id you ask.

SHOW THE PLAN: when the user asks to SEE it — "present/show the architecture",
"what are the requirements / user stories", "show me the plan/spec/design" —
do NOT lock-in+ask. Set action:"status"; the harness prints the whole plan.

reply — a CONVERSATION, not a status report. Never dump a list of
capabilities and stop. Each turn, in <=80 words, do TWO things:
  1. say what you LOCKED IN — the decisions/defaults you just made FOR them,
     so they can veto a bad one ("I'll default to local storage and the Web
     Speech API — say if either's wrong").
  2. ASK the single next open fork as a real, direct QUESTION ending in "?",
     with your suggestion ("What's her age? I'd guess 7-9."). End ON the
     question. NEVER end on "Next: <topic>" — ask it.
No preamble, no praise, no restating the goal, no filler. Your reply must
MATCH the deltas — never claim a record you did not put in deltas. When
nothing is open, say it's ready to build instead of asking.

deltas — IN THE BACKGROUND, record everything decided, claimed, required, or
asked as spec deltas (add/modify/resolve/remove by section and id). Nothing
the user said may change the spec without a delta. Never a no-op delta. If
the message pivots to a DIFFERENT product, include a thesis modify delta
with drift:true — never bury a pivot in scope_fence. EXCEPTION: while the
thesis is still a TODO placeholder this is a NEW spec — the first real idea
SETS it (thesis modify, drift:false), and TODO placeholders (thesis, R1)
are REPLACED with real content, never kept alongside additions.

CRITICAL — capture, DECOMPOSE, and raise the forks that change gates:
- thesis modify value is ALWAYS a plain string, never an object.
- When the user describes a PRODUCT ("an ai companion for my daughter"),
  set the thesis AND decompose it into the CAPABILITIES it implies — one
  requirement per capability (e.g. voice in/out, presence detection, safe
  content, persistence), each with a proposed gate. Replace the R1
  placeholder; do NOT stop at a single coarse requirement that just restates
  the thesis — one vague requirement is NOT a buildable spec. Never ask them
  to restate the goal.

PROPOSE gates; never interrogate on trivia. You own the gate ladder:
- mechanical/behavioral -> tier 1 {"tier":1,"gate":"<shell cmd>"}.
- subjective quality ("safe", "feels alive", "child-appropriate") -> tier 4
  {"tier":4,"artifact":"<path a human reviews in <1 min>"} + tier-1 proxies.
NEVER ask "what should the check be?" — propose it.

WHEN THE USER ANSWERS a blocking question (even in passing, even once), you
MUST emit op:resolve for that open_question in the SAME turn AND record their
answer as a decision — so it stops blocking. NEVER leave an answered question
open, and NEVER re-ask it. If they push back ("i told you laptop already"),
they are right: resolve the question with their answer immediately.

TECHNICAL choices are YOURS to default — never ask them. Which voice engine,
library, framework, database, algorithm: pick the best-practice default for
the stated context (Web Speech API on a Chromebook; SQLite for local storage)
and record it as a decision. Your judgment on the stack >= the user's.

ASK the load-bearing forks — and ONLY those. A question is worth asking iff
(a) the answer is a FACT ONLY THE USER HOLDS (their hardware, their child's
age, their content rules — NOT a tech choice you can default), AND (b) it
changes a GATE, a DECISION, or a FEASIBILITY verdict. Raise each such fork as
a BLOCKING open_question (blocking:true). For a child's AI companion the real
forks are e.g.: target hardware/runtime (the user holds this — changes every
gate), the child's age (sets the content gate), what "safe" must concretely
mean (the tier-4 artifact). Typically 1-3 for a new product, then none.

WALK the open questions ONE AT A TIME. After this turn's edits, if any blocking
open_question remains, ask exactly ONE — the most important — at the end of
your reply, in plain words, including your suggested answer ("I'd go with X").
Ask only that one; do not list them all. When none remain, do not ask anything.

question field — surface at most ONE terse fork in the reply per turn (the
highest-value one); record ALL the forks as blocking open_questions regardless.
Once you have proposed gates for the requirements, RESOLVE the blank-spec
placeholder question Q1 ("first requirement's objective check") — it is
superseded by your real forks; never leave it lingering.

${SPEC_ITEM_SHAPES}

${GATE_LADDER_DOC}

Detailed test design happens later at derive; acceptance needs the right
TIER plus a real command or artifact.`;

/** Pure: apply a delta batch to a spec, re-validating the result. */
export function applyDeltas(spec: Spec, deltas: Delta[]): Spec {
  const draft: Record<string, unknown> = JSON.parse(JSON.stringify(spec));
  for (const d of deltas) {
    if (d.section === "thesis") {
      if (d.op !== "modify" || typeof d.value !== "string") {
        throw new SquireError("DELTA_INVALID", "thesis only supports modify with a string value");
      }
      draft.thesis = d.value;
      continue;
    }
    if (d.section === "scope_fence") {
      const fence = draft.scope_fence as string[];
      if (d.op === "add" && typeof d.value === "string") fence.push(d.value);
      else if (d.op === "remove" && typeof d.value === "string") {
        draft.scope_fence = fence.filter((f) => f !== d.value);
      } else throw new SquireError("DELTA_INVALID", "scope_fence supports add/remove with a string value");
      continue;
    }
    const list = draft[d.section] as { id: string }[];
    switch (d.op) {
      case "add":
        list.push(d.value as { id: string });
        break;
      case "modify": {
        const i = list.findIndex((x) => x.id === d.id);
        if (i === -1) throw new SquireError("DELTA_INVALID", `${d.section}/${d.id} not found for modify`);
        list[i] = { ...list[i], ...(d.value as object), id: d.id! };
        break;
      }
      case "remove":
      case "resolve": {
        const i = list.findIndex((x) => x.id === d.id);
        if (i === -1) throw new SquireError("DELTA_INVALID", `${d.section}/${d.id} not found for ${d.op}`);
        if (d.op === "resolve" && d.section === "open_questions") list.splice(i, 1);
        else if (d.op === "remove") list.splice(i, 1);
        else throw new SquireError("DELTA_INVALID", "resolve only applies to open_questions");
        break;
      }
    }
  }
  const checked = SpecSchema.safeParse(draft);
  if (!checked.success) {
    throw new SquireError(
      "DELTA_INVALID",
      `applying deltas would invalidate the spec:\n${formatZodIssues(checked.error.issues)}`,
    );
  }
  return checked.data;
}

const DELTA_OPS = new Set(["add", "modify", "remove", "resolve"]);
const DELTA_SECTIONS = new Set(["thesis", "scope_fence", "requirements", "decisions", "claims", "open_questions"]);

/**
 * Accept the model's NATURAL delta shapes, not just our canonical one. The
 * cheap model reliably emits op-keyed, section-batched deltas like
 *   {"add": {"requirements": [item, item]}}
 *   {"remove": {"requirements": ["R1"]}}
 *   {"resolve": {"open_questions": ["Q1"]}}
 * Our schema wanted flat {section, op, value} one-per-delta and .strict()
 * dropped all of the above — so autofill did nothing against the real model.
 * This flattens any shape into canonical raw deltas (still unvalidated; the
 * DeltaSchema parses them next). The harness adapts to the model.
 */
export function coerceRawDeltas(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const out: unknown[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.section === "string" && typeof e.op === "string") {
      out.push(e); // already canonical
      continue;
    }
    const opKey = Object.keys(e).find((k) => DELTA_OPS.has(k));
    if (!opKey || !e[opKey] || typeof e[opKey] !== "object") continue;
    for (const [section, payload] of Object.entries(e[opKey] as Record<string, unknown>)) {
      if (!DELTA_SECTIONS.has(section)) continue;
      if (section === "thesis") {
        out.push({ section, op: opKey, value: payload });
      } else if (opKey === "remove" || opKey === "resolve") {
        for (const id of Array.isArray(payload) ? payload : [payload]) {
          out.push({ section, op: opKey, id: typeof id === "string" ? id : (id as { id?: unknown })?.id });
        }
      } else {
        for (const item of Array.isArray(payload) ? payload : [payload]) {
          if (section === "scope_fence") out.push({ section, op: opKey, value: item });
          else out.push({ section, op: opKey, value: item, id: (item as { id?: unknown })?.id });
        }
      }
    }
  }
  return out;
}

/** Keep the conversation, salvage individually-valid deltas, drop the rest. */
export function salvageBatch(raw: unknown): DeltaBatch {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const deltas: Delta[] = [];
  for (const d of coerceRawDeltas(o.deltas)) {
    const ok = DeltaSchema.safeParse(d);
    if (ok.success) deltas.push(ok.data);
  }
  const action = (TALK_ACTIONS as readonly string[]).includes(o.action as string)
    ? (o.action as DeltaBatch["action"])
    : "none";
  return {
    deltas,
    question: typeof o.question === "string" ? o.question : "",
    reply: typeof o.reply === "string" ? o.reply : "",
    note: "",
    action,
    action_arg: typeof o.action_arg === "string" ? o.action_arg : "",
    pivot: false, // set by finishTurn from the deltas
    asking: typeof o.asking === "string" ? o.asking : "",
  };
}

/**
 * Apply deltas one at a time, skipping any that would invalidate the spec —
 * the bookkeeper must never lose the whole batch (or the conversation) to one
 * bad edit. Returns what applied and why the rest dropped.
 */
export function applyDeltasLenient(
  spec: Spec,
  deltas: Delta[],
): { spec: Spec; applied: Delta[]; dropped: { delta: Delta; reason: string }[] } {
  let current = spec;
  const applied: Delta[] = [];
  const dropped: { delta: Delta; reason: string }[] = [];
  for (const d of deltas) {
    try {
      current = applyDeltas(current, [d]);
      applied.push(d);
    } catch (err) {
      dropped.push({ delta: d, reason: (err as Error).message.split("\n").slice(0, 2).join(" ") });
    }
  }
  return { spec: current, applied, dropped };
}

/** Mechanical drift check: flag deltas the proposer didn't self-flag. */
export function markDrift(batch: DeltaBatch): DeltaBatch {
  return batch; // proposer-flagged only in v0.2; mechanical NLI check is v0.3 (A26)
}

const LIST_PREFIX: Record<string, string> = {
  requirements: "R",
  decisions: "D",
  claims: "C",
  open_questions: "Q",
};

/** Schema-valid id for a list section is exactly <prefix><digits> (e.g. R1, D2). */
function validListId(section: string, id: unknown): id is string {
  const p = LIST_PREFIX[section];
  return typeof id === "string" && p !== undefined && new RegExp(`^${p}\\d+$`).test(id);
}

/** Allocator that hands out fresh schema-valid ids, never colliding with taken ones. */
function makeIdAllocator(section: string, taken: Set<string>): () => string {
  const prefix = LIST_PREFIX[section]!;
  let n = 0;
  for (const id of taken) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return () => {
    n += 1;
    const id = `${prefix}${n}`;
    taken.add(id);
    return id;
  };
}

function isPlaceholderReq(r: unknown): boolean {
  const o = r as { statement?: unknown };
  return typeof o?.statement === "string" && /^TODO\b/i.test(o.statement);
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    for (const k of ["value", "statement", "thesis", "text"]) {
      if (typeof o[k] === "string") return o[k] as string;
    }
  }
  return null;
}

/**
 * Make the cheap model's deltas land. The HARNESS owns ids and shapes, not the
 * model — so the whole class of id bugs (dotted R1.1, undefined, collisions)
 * is repaired here rather than dropped. The model supplies content and may use
 * ANY handle for a new item; this function mints the real id and rewrites any
 * same-batch reference to it (a decision citing a claim added this turn keeps
 * pointing at the right claim). It never invents content — only fixes shape:
 *  - thesis modify with a non-string value -> the extracted string.
 *  - list add -> a fresh schema-valid id (the model's handle is remapped).
 *  - list modify with a missing/unknown id -> the TODO placeholder for
 *    requirements, a same-batch handle, else an upsert add.
 *  - requirement add/fill with no acceptance -> tier 0 (captured now, gated next).
 *  - decision.claims refs -> remapped through this batch's handle->id map.
 */
export function normalizeDeltas(spec: Spec, deltas: Delta[]): Delta[] {
  const out: Delta[] = [];
  const reqs = spec.requirements as { id: string; statement: string }[];
  let placeholderId: string | undefined = reqs.find(isPlaceholderReq)?.id;

  const sections = ["requirements", "decisions", "claims", "open_questions"] as const;
  const taken: Record<string, Set<string>> = {};
  const alloc: Record<string, () => string> = {};
  for (const s of sections) {
    taken[s] = new Set(((spec as unknown as Record<string, { id: string }[]>)[s] ?? []).map((x) => x.id));
    alloc[s] = makeIdAllocator(s, taken[s]!);
  }
  // handle (whatever the model called a new item) -> the real minted id.
  const remap: Record<string, string> = {};

  const withAcceptance = (val: Record<string, unknown>, id: string): Record<string, unknown> => {
    const v: Record<string, unknown> = { ...val, id };
    if (v.acceptance === undefined) v.acceptance = { tier: 0 };
    return v;
  };
  // Rewrite a decision's claim references through this batch's remap.
  const fixClaims = (val: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    if (!val || !Array.isArray(val.claims)) return val;
    return { ...val, claims: (val.claims as unknown[]).map((c) => (typeof c === "string" && remap[c]) || c) };
  };
  // Add to a list with a guaranteed-valid, non-colliding id; record the remap.
  const emitAdd = (d: Delta, val: Record<string, unknown> | undefined): void => {
    const section = d.section;
    const provided = typeof val?.id === "string" ? (val.id as string) : undefined;
    const keep = validListId(section, provided) && !taken[section]!.has(provided!);
    const id = keep ? ((taken[section]!.add(provided!), provided!)) : alloc[section]!();
    if (provided && provided !== id) remap[provided] = id;
    let value: Record<string, unknown> = section === "requirements" ? withAcceptance(val ?? {}, id) : { ...(val ?? {}), id };
    if (section === "decisions") value = fixClaims(value)!;
    out.push({ ...d, op: "add", id: undefined, value });
  };

  for (const d of deltas) {
    if (d.section === "thesis") {
      if (d.op === "modify") {
        const s = asString(d.value);
        out.push(s !== null ? { ...d, value: s } : d);
      } else out.push(d);
      continue;
    }
    // scope_fence holds plain strings, not id-bearing items — pass through.
    if (d.section === "scope_fence") {
      out.push(d);
      continue;
    }

    const ids = taken[d.section]!;
    const val = d.value && typeof d.value === "object" ? (d.value as Record<string, unknown>) : undefined;
    const valId = typeof val?.id === "string" ? (val.id as string) : undefined;
    // Resolve a referenced id: existing, or a same-batch handle we just minted.
    const resolve = (id?: string): string | undefined =>
      id && ids.has(id) ? id : id && remap[id] && ids.has(remap[id]!) ? remap[id] : undefined;

    if (d.op === "modify") {
      const targetId = resolve(d.id) ?? resolve(valId);
      if (targetId) {
        const value = fixClaims(val ? { ...val, id: targetId } : undefined) ?? d.value;
        out.push({ ...d, id: targetId, value });
        continue;
      }
      if (d.section === "requirements" && placeholderId) {
        out.push({ ...d, op: "modify", id: placeholderId, value: withAcceptance(val ?? {}, placeholderId) });
        placeholderId = undefined;
        continue;
      }
      emitAdd(d, val); // upsert
      continue;
    }

    if (d.op === "add") {
      if (d.section === "requirements" && placeholderId && !isPlaceholderReq(val)) {
        if (valId) remap[valId] = placeholderId;
        out.push({ ...d, op: "modify", id: placeholderId, value: withAcceptance(val ?? {}, placeholderId) });
        placeholderId = undefined;
        continue;
      }
      emitAdd(d, val);
      continue;
    }

    // remove / resolve: retarget to an existing or same-batch id; drop if unresolvable.
    const targetId = resolve(d.id) ?? resolve(valId);
    if (targetId) out.push({ ...d, id: targetId });
    // unresolved remove/resolve is a no-op (the item never existed) — drop silently
  }
  return out;
}

// ── Reconcile: resolve open_questions a decision already answers (A37) ──
// The mapper re-asks questions the spec already answers, as SEMANTIC duplicates
// ("what's her age?" while a decision records "4-year-old") that lexical rules
// can't catch. This is the one judgment that needs a model — but the model only
// IDENTIFIES; the harness applies the resolves. Narrow task, cheap model.
export const RECONCILE_PROMPT = `You are a STRICT bookkeeper. Below are DECISIONS already locked in and OPEN
QUESTIONS still being asked. Return ONLY the questions that a decision ALREADY,
DEFINITIVELY answers — asking them again would make the user repeat themselves.
Be conservative: if no decision clearly answers a question, LEAVE IT OPEN.
Match on meaning, not words (a decision "designed for a 4-year-old" answers
"what is the child's age?"). Output ONLY JSON:
{"resolved":[{"question":"Q#","decision":"D#"}]}`;

const ReconcileSchema = z
  .object({
    resolved: z
      .array(z.object({ question: z.string(), decision: z.string() }).passthrough())
      .default([]),
  })
  .passthrough();

// ── Capture: turn stated constraints into recorded decisions (A40) ──
export const CAPTURE_DECISIONS_PROMPT = `Extract the concrete product DECISIONS or constraints the user JUST stated —
platform/hardware, storage, scope limits, specific choices, hard requirements.
Phrase each as a short, specific decision in the user's intent. ONLY new ones
not already in EXISTING DECISIONS; if they stated nothing concrete, return an
empty list. Do NOT invent — capture only what they actually said.
Output ONLY JSON: {"decisions":[{"statement":"..."}]}`;

const CaptureDecisionsSchema = z.object({
  decisions: z.array(z.object({ statement: z.string().min(1) }).passthrough()).default([]),
});

/** Significant-word overlap of two short statements (0..1) — cheap dedupe. */
function wordOverlap(a: string, b: string): number {
  const sig = (s: string): Set<string> => new Set(s.split(/[^a-z0-9]+/i).filter((w) => w.length >= 4));
  const x = sig(a);
  const y = sig(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter += 1;
  return inter / Math.min(x.size, y.size);
}

export interface SpecSessionOptions {
  path: string;
  llm: LlmClient;
  executorModel: string;
  knightModel: string;
  /** Consecutive rejected batches before generative turns escalate (SPEC-v0.2 §5.2). */
  escalateAfter?: number;
  git?: boolean;
}

export class SpecSession {
  readonly path: string;
  private readonly opts: SpecSessionOptions;
  private consecutiveRejections = 0;
  private usage = { in: 0, out: 0 };
  /** The open_question the model surfaced last turn, so the next answer is
   *  guaranteed-recorded even if the model forgets to resolve it (A37). */
  private lastAskedId = "";

  constructor(opts: SpecSessionOptions) {
    this.opts = opts;
    this.path = opts.path;
    if (!existsSync(opts.path)) {
      throw new SquireError("SPEC_NOT_FOUND", `spec not found: ${opts.path} (ser spec init first)`);
    }
  }

  /** State lives in the artifact: every read comes from disk (resume = free). */
  load(): Spec {
    return parseSpec(readFileSync(this.path, "utf8"), this.path);
  }

  /** The model for the next generative turn — escalates on demonstrated failure. */
  currentModel(): string {
    return this.consecutiveRejections >= (this.opts.escalateAfter ?? 2)
      ? this.opts.knightModel
      : this.opts.executorModel;
  }

  /** One turn: user message → proposed delta batch (NOT yet applied). */
  async turn(userMessage: string): Promise<DeltaBatch> {
    const spec = this.load();
    const model = this.currentModel();
    let note = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.opts.llm.complete({
        model,
        system: DELTA_MAPPER_PROMPT,
        user: `CURRENT SPEC (yaml):\n${yamlStringify(spec)}\n\nUSER MESSAGE:\n${userMessage}${note}`,
        json: true,
        maxTokens: 2000,
      });
      this.usage.in += res.inTokens;
      this.usage.out += res.outTokens;
      const parsed = tryParseJson(res.text);
      if (parsed.ok) {
        // Coerce the model's natural op-keyed shape to canonical BEFORE schema
        // validation, so the happy path works first try (no wasted retry).
        const coerced =
          parsed.value && typeof parsed.value === "object"
            ? { ...(parsed.value as object), deltas: coerceRawDeltas((parsed.value as { deltas?: unknown }).deltas) }
            : parsed.value;
        const checked = DeltaBatchSchema.safeParse(coerced);
        if (checked.success) return this.postProcess(markDrift(checked.data), spec, userMessage);
        if (attempt === 1) return this.postProcess(salvageBatch(parsed.value), spec, userMessage); // degrade, never crash
        note = `\n\nYour previous output failed validation:\n${formatZodIssues(checked.error.issues)}`;
      } else {
        if (attempt === 1) {
          // Bookkeeping failed twice; keep the conversation alive with raw text.
          return { deltas: [], question: "", note: "", reply: res.text.slice(0, 400), action: "none" as const, action_arg: "", pivot: false, asking: "" };
        }
        note = `\n\nYour previous output was not valid JSON: ${parsed.error}`;
      }
    }
    throw new SquireError("SPEC_TURN_INVALID", "unreachable");
  }

  /** Normalize deltas against the right base (blank on a pivot) and flag the pivot. */
  private finishTurn(b: DeltaBatch, spec: Spec): DeltaBatch {
    const pivot = isPivot(b.deltas);
    const base = pivot ? blankPivotSpec() : spec;
    return { ...b, deltas: normalizeDeltas(base, b.deltas), pivot };
  }

  /**
   * Between the model's raw batch and the applied one, do the two things the
   * model is unreliable at (A37):
   *  1. GUARANTEE the answer is recorded. If last turn asked a blocking
   *     question and this message answers it but the model didn't resolve it,
   *     the harness resolves it + records the answer as a decision — so the
   *     spec (the ONLY memory) actually holds it and it is never re-asked.
   *  2. PRESENT the plan on request. "show/present the architecture/plan" maps
   *     to the status action (the harness prints the full plan) instead of a
   *     lock-in + re-ask.
   * Then remember the question now on the table for next turn's guarantee.
   */
  private postProcess(batch: DeltaBatch, spec: Spec, userMessage: string): DeltaBatch {
    if (!isPivot(batch.deltas)) {
      if (batch.action === "none" && SHOW_PLAN_RE.test(userMessage)) {
        batch.action = "status";
        if (!batch.reply.trim()) batch.reply = "here's where the plan stands:";
      }
      if (
        batch.action === "none" &&
        this.lastAskedId &&
        isAnswerShaped(userMessage) &&
        !batch.deltas.some(
          (d) => d.section === "open_questions" && (d.op === "resolve" || d.op === "remove") && d.id === this.lastAskedId,
        )
      ) {
        const q = spec.open_questions.find((o) => o.id === this.lastAskedId && o.blocking);
        if (q) {
          batch.deltas.push(
            { section: "open_questions", op: "resolve", id: q.id, drift: false },
            {
              section: "decisions",
              op: "add",
              drift: false,
              value: {
                statement: `${q.text} → ${userMessage.trim()}`,
                rationale: "recorded from the user's answer",
                claims: [],
              },
            },
          );
        }
      }
    }
    const finished = this.finishTurn(batch, spec);
    const remaining = remainingBlockingQuestions(spec, finished.deltas);
    this.lastAskedId =
      batch.asking && remaining.some((q) => q.id === batch.asking)
        ? batch.asking
        : remaining.length === 1
          ? remaining[0]!.id
          : "";
    return finished;
  }

  /** Accept a batch: apply, save, git-commit. Resets the rejection counter. */
  async accept(batch: DeltaBatch): Promise<Spec> {
    const next = applyDeltas(batch.pivot ? blankPivotSpec() : this.load(), batch.deltas);
    writeFileSync(this.path, yamlStringify(next));
    this.consecutiveRejections = 0;
    if (this.opts.git !== false) {
      const dir = dirname(this.path);
      await execa("git", ["add", basename(this.path)], { cwd: dir, reject: false });
      await execa(
        "git",
        ["commit", "-q", "-m", `spec(${basename(this.path)}): ${batch.deltas.length} delta(s)`],
        { cwd: dir, reject: false },
      );
    }
    return next;
  }

  /** Lenient accept: apply what validates, report what dropped. Saves + commits when anything applied. */
  async acceptLenient(batch: DeltaBatch): Promise<{ applied: Delta[]; dropped: { delta: Delta; reason: string }[] }> {
    const { spec, applied, dropped } = applyDeltasLenient(batch.pivot ? blankPivotSpec() : this.load(), batch.deltas);
    if (applied.length > 0) {
      writeFileSync(this.path, yamlStringify(spec));
      this.consecutiveRejections = 0;
      if (this.opts.git !== false) {
        const dir = dirname(this.path);
        await execa("git", ["add", basename(this.path)], { cwd: dir, reject: false });
        await execa("git", ["commit", "-q", "-m", `spec(${basename(this.path)}): ${applied.length} delta(s)`], { cwd: dir, reject: false });
      }
    }
    return { applied, dropped };
  }

  /**
   * Resolve open_questions an existing decision already answers (A37) — the
   * semantic dedupe the mapper won't do, so the spec stops carrying (and the
   * model stops re-asking) settled questions. The model only identifies; the
   * harness validates the ids and applies the resolves. Best-effort: any
   * failure (bad JSON, network) resolves nothing rather than throwing. Skips
   * the call entirely unless there is both a decision and a blocking question.
   * Returns the resolve deltas applied.
   */
  async reconcile(): Promise<Delta[]> {
    const spec = this.load();
    const blocking = spec.open_questions.filter((q) => q.blocking);
    if (spec.decisions.length === 0 || blocking.length === 0) return [];
    let res;
    try {
      res = await this.opts.llm.complete({
        model: this.opts.executorModel,
        system: RECONCILE_PROMPT,
        user:
          `DECISIONS:\n${spec.decisions.map((d) => `${d.id}: ${d.statement}`).join("\n")}\n\n` +
          `OPEN QUESTIONS:\n${blocking.map((q) => `${q.id}: ${q.text}`).join("\n")}`,
        json: true,
        maxTokens: 600,
      });
    } catch {
      return [];
    }
    this.usage.in += res.inTokens;
    this.usage.out += res.outTokens;
    const parsed = tryParseJson(res.text);
    if (!parsed.ok) return [];
    const checked = ReconcileSchema.safeParse(parsed.value);
    if (!checked.success) return [];
    const qIds = new Set(blocking.map((q) => q.id));
    const dIds = new Set(spec.decisions.map((d) => d.id));
    const deltas: Delta[] = [];
    const seen = new Set<string>();
    for (const item of checked.data.resolved) {
      // only resolve a REAL blocking question justified by a REAL decision
      if (qIds.has(item.question) && dIds.has(item.decision) && !seen.has(item.question)) {
        seen.add(item.question);
        deltas.push({ section: "open_questions", op: "resolve", id: item.question, drift: false });
      }
    }
    if (deltas.length === 0) return [];
    const next = applyDeltas(spec, deltas);
    writeFileSync(this.path, yamlStringify(next));
    if (this.opts.git !== false) {
      const dir = dirname(this.path);
      await execa("git", ["add", basename(this.path)], { cwd: dir, reject: false });
      await execa(
        "git",
        ["commit", "-q", "-m", `spec(${basename(this.path)}): reconcile ${deltas.length} answered`],
        { cwd: dir, reject: false },
      );
    }
    return deltas;
  }

  /**
   * Record the concrete decisions the user just STATED that the mapper failed to
   * capture (A40). The eval's headline finding: ser-talk crystallized ~0
   * decisions while a vanilla one-shot produced 5 — resolving a question, or a
   * volunteered fact ("I'm on iPhone", "local storage"), never became a recorded
   * decision. This is reconcile's sibling: the model EXTRACTS, the harness adds.
   * Best-effort; dedups against existing decisions. Returns the added deltas.
   */
  async captureDecisions(userMessage: string): Promise<Delta[]> {
    if (!userMessage.trim()) return [];
    const spec = this.load();
    const existing = spec.decisions.map((d) => d.statement);
    let res;
    try {
      res = await this.opts.llm.complete({
        model: this.opts.executorModel,
        system: CAPTURE_DECISIONS_PROMPT,
        user: `EXISTING DECISIONS:\n${existing.map((s) => `- ${s}`).join("\n") || "(none)"}\n\nUSER JUST SAID:\n${userMessage}`,
        json: true,
        maxTokens: 400,
      });
    } catch {
      return [];
    }
    this.usage.in += res.inTokens;
    this.usage.out += res.outTokens;
    const parsed = tryParseJson(res.text);
    if (!parsed.ok) return [];
    const checked = CaptureDecisionsSchema.safeParse(parsed.value);
    if (!checked.success) return [];
    const seen = existing.map((s) => s.toLowerCase());
    const deltas: Delta[] = [];
    for (const d of checked.data.decisions) {
      const s = d.statement.trim();
      if (!s || seen.some((e) => wordOverlap(e, s.toLowerCase()) >= 0.6)) continue;
      seen.push(s.toLowerCase());
      deltas.push({ section: "decisions", op: "add", drift: false, value: { statement: s, rationale: "captured from the conversation", claims: [] } });
    }
    if (deltas.length === 0) return [];
    const normalized = normalizeDeltas(spec, deltas);
    const next = applyDeltas(spec, normalized);
    writeFileSync(this.path, yamlStringify(next));
    if (this.opts.git !== false) {
      const dir = dirname(this.path);
      await execa("git", ["add", basename(this.path)], { cwd: dir, reject: false });
      await execa("git", ["commit", "-q", "-m", `spec(${basename(this.path)}): capture ${normalized.length} decision(s)`], { cwd: dir, reject: false });
    }
    return normalized;
  }

  /** Reject a batch: nothing applies; repeated rejections escalate the model. */
  reject(): void {
    this.consecutiveRejections += 1;
  }

  tokens(): { in: number; out: number } {
    return { ...this.usage };
  }
}

/** `ser spec check` — the five spec gates (SPEC-v0.2 §5.3), mechanical subset. */
export function checkSpec(spec: Spec): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;

  // 1. schema — parsing already proved it
  lines.push("✓ schema valid");

  // 2+3. claims + adversarial (recorded verdicts)
  const pending = unverifiedLoadBearing(spec);
  if (pending.length > 0) {
    ok = false;
    for (const p of pending) lines.push(`✗ claims: ${p.decision} rests on ${p.claim} (not verified)`);
  } else lines.push("✓ all load-bearing claims verified");

  // 4. executability pre-gates (unanchored requirements, refuted decisions)
  const refusal = specPreGate(spec);
  if (refusal) {
    ok = false;
    for (const r of refusal.reasons) lines.push(`✗ ${r}`);
    for (const rem of refusal.remediations) {
      lines.push(`  ${rem.requirement}: ${rem.options.map((o) => o.split(":")[0]).join(" | ")}`);
    }
  } else lines.push("✓ executability pre-gates (anchoring, decisions, blocking questions)");

  lines.push(ok ? "spec: READY to compile (ser derive <file>)" : "spec: NOT ready");
  return { ok, lines };
}

/**
 * `ser spec verify <claim-id>` — run the adversarial lenses on one ledger
 * claim and record the verdict. Survival across all lenses marks the claim
 * verified with the lens evidence trail (A27: v0.2's working definition of
 * verified is adversarial-survival); a refutation WITH evidence marks refuted.
 */
export async function verifyClaim(
  spec: Spec,
  claimId: string,
  llm: LlmClient,
  model: string,
): Promise<{ spec: Spec; verdict: "verified" | "refuted"; evidence: string }> {
  const { LENSES } = await import("./derive2.js");
  const claim = spec.claims.find((c) => c.id === claimId);
  if (!claim) throw new SquireError("CLAIM_NOT_FOUND", `claim ${claimId} not in the ledger`);

  const evidence: string[] = [];
  let refutedBy = "";
  for (const lens of LENSES) {
    const res = await llm.complete({
      model,
      system: `${lens.instruction} Output ONLY JSON: {"refuted": boolean, "evidence": "shown arithmetic or named sources — REQUIRED when refuted"}.`,
      user: `CLAIM: ${claim.statement}`,
      json: true,
      maxTokens: 1500,
    });
    const parsed = tryParseJson(res.text);
    if (!parsed.ok) continue;
    const v = z.object({ refuted: z.boolean(), evidence: z.string().default("") }).safeParse(parsed.value);
    if (!v.success) continue;
    if (v.data.refuted && v.data.evidence.trim().length >= 10) {
      refutedBy = `[${lens.id}] ${v.data.evidence}`;
      break;
    }
    evidence.push(`[${lens.id}] survived${v.data.evidence ? `: ${v.data.evidence}` : ""}`);
  }

  const verdict = refutedBy ? "refuted" : "verified";
  const updated = applyDeltas(spec, [
    {
      section: "claims",
      op: "modify",
      id: claimId,
      value: { status: verdict, evidence: refutedBy || `survived adversarial lenses on ${model}: ${evidence.join("; ")}` },
      drift: false,
    },
  ]);
  return { spec: updated, verdict, evidence: refutedBy || evidence.join("; ") };
}
