import { z } from "zod";
import { SquireError } from "../errors.js";
import type { LlmClient } from "../llm/types.js";
import { tryParseJson, formatZodIssues } from "./derive.js";
import { CASTELLAN_IDENTITY, GATE_LADDER_DOC } from "./self-knowledge.js";

/**
 * The IDEA phase (pipeline slice 1). A vague product prompt becomes: the key
 * USER STORIES (what the user actually does), the COMPONENTS those stories
 * require (the union = "minimum viable"), and the open DECISIONS — each sorted
 * into one of three buckets by expected value of the answer:
 *
 *   bucket 1 — ASK NOW    : can't-guess AND forks-hard AND costly-to-undo
 *   bucket 2 — DEFAULT+FLAG: matters but has a sane default / cheap to flip later
 *   bucket 3 — SILENT      : trivia, not even surfaced
 *
 * Honesty rule (model never grades its own homework): the model assesses three
 * boolean PROPERTIES per decision; the BUCKET is derived in code below, so an
 * over-eager model can't manufacture "ask the user" interruptions.
 */

export type Bucket = 1 | 2 | 3;

export interface ThreeTest {
  /** Can ser confidently pick a default WITHOUT asking (best practice / obvious)? */
  canGuess: boolean;
  /** Do different answers lead to a materially different build? */
  forksHard: boolean;
  /** If defaulted wrong, is it expensive to reverse (forces a rebuild)? */
  costlyToUndo: boolean;
}

/** Pure: the 3-test → bucket. Code owns the bucketing; the model only supplies facts. */
export function bucketOf(t: ThreeTest): Bucket {
  if (!t.forksHard) return 3; // cosmetic / trivia → decide silently
  if (t.canGuess || !t.costlyToUndo) return 2; // matters, but defaultable or cheap to flip
  return 1; // forks hard, can't guess, costly to undo → ASK NOW (blocks readiness)
}

export interface Decision extends ThreeTest {
  question: string;
  /** What this changes — a gate, a component, feasibility. */
  why: string;
  recommendation: string;
  alternatives: string[];
  bucket: Bucket;
}

export interface Component {
  statement: string;
  /** Which user story this component serves. */
  story: string;
  gate: { tier: number; gate?: string; artifact?: string };
}

export interface IdeaResult {
  stories: string[];
  components: Component[];
  decisions: Decision[];
}

const IdeaSchema = z.object({
  stories: z.array(z.string()).default([]),
  components: z
    .array(
      z.object({
        statement: z.string(),
        story: z.string().default(""),
        gate: z
          .object({ tier: z.number(), gate: z.string().optional(), artifact: z.string().optional() })
          .default({ tier: 0 }),
      }),
    )
    .default([]),
  decisions: z
    .array(
      z.object({
        question: z.string(),
        why: z.string().default(""),
        recommendation: z.string().default(""),
        alternatives: z.array(z.string()).default([]),
        canGuess: z.boolean(),
        forksHard: z.boolean(),
        costlyToUndo: z.boolean(),
      }),
    )
    .default([]),
});

export const IDEA_PROMPT = `${CASTELLAN_IDENTITY}

You are the IDEA phase. Turn a one-line product prompt into a buildable shape.

0. REALITY CHECK (do this FIRST, it governs everything below). Ask: what would it
   ACTUALLY take for this to ACHIEVE THE USER'S STATED GOAL? When the goal is
   ambitious or outcome-oriented ("influence public opinion", "make money", "go
   viral", "rank #1", "change minds"), the build-defining fork is almost NEVER
   technical — it is MECHANISM and SCALE: by what concrete mechanism does this move
   the needle, and at what scale (one unit, or a coordinated many)? Surface THAT as
   the crux decision (canGuess=FALSE, forksHard=TRUE, costlyToUndo=TRUE). If the
   minimal stories would NOT plausibly achieve the stated goal, SAY SO in a
   decision — never quietly ship a thin core that cannot work; that is the failure
   the user notices last and resents most. AND when the approach leans on deception,
   inauthentic accounts, manipulation, or breaking a platform's terms (astroturfing,
   fake engagement, coordinated sockpuppets), surface LEGITIMACY as a first-class
   fork: name the honest/authentic alternative, and that the inauthentic path very
   likely violates platform ToS and may be unlawful — do not refuse and do not
   moralize, but the user must choose it knowingly. AND when the product's JOB is to
   handle SENSITIVE ASSETS — secrets / API keys / credentials, authentication,
   personal or financial data, access control — and the stated approach embodies a
   known SECURITY ANTI-PATTERN (handing a caller the RAW secret instead of
   injecting/leashing it so it is never exposed; returning a credential that should
   only ever be USED server-side; storing credentials in plaintext; trusting
   client-supplied identity), surface SAFETY as a first-class fork EVEN IF the input
   stated that approach. Name the safer architecture as the recommendation
   (use-without-exposing: the secret is injected at the boundary and never returned; a
   scoped, revocable capability in place of the raw key) and that the stated path is
   the load-bearing risk this very product category exists to avoid. ONE crux safety
   fork, not a security checklist; it fires ONLY when the product's purpose is the
   sensitive asset AND the approach is load-bearing-unsafe — never nag a product that
   merely touches data in passing. Do not refuse and do not moralize; the user chooses
   knowingly (canGuess=FALSE, forksHard=TRUE, costlyToUndo=TRUE).

1. USER STORIES — what a typical user EXPECTS this product to do, INCLUDING what
   they'd assume without saying. Missing detail means "give me the obvious shape for
   THIS kind of product", NOT "give me the minimum that technically qualifies": a
   "casino poker webapp" is a table with chips and betting controls, not a JSON API;
   an "arcade with Super Mario vibes" is an actual playable platformer in a cabinet,
   not a color palette. The test for inclusion: would most users of this kind of
   product be SURPRISED to find it missing? If yes, it is core. Cut only genuine v2
   features and unrelated nice-to-haves (a poker app's tournament mode is v2; its
   betting table is not; "edit a past entry" in a to-do app is later). Concrete and
   observable, in plain words ("she asks a question and gets a kid-safe answer").
   Uses, not features.

2. COMPONENTS — for each story, the component(s) a typical user expects: the FULL
   expected shape, not a skeleton. Give each a BEHAVIORAL gate: a tier-1 SHELL
   COMMAND that proves the behavior actually HAPPENS (a coin pickup increments score
   by 100; the chip stack decrements by the bet; the card flips face-up on reveal;
   the enemy dies when stomped; exit 0 = pass). The spec LOOPS UNATTENDED, so every
   component needs a machine-checkable gate — but the answer to "this is hard to
   gate" is MAKE IT CONCRETE ENOUGH TO GATE, never DROP IT. Decompose the vague
   ambition the user named ("immersive", "realistic", "personable", "fun", "Super
   Mario vibes") into the concrete BEHAVIORS that constitute it, and gate those.
   Almost everything reduces to a command — HUNT for it:
     "feels responsive" → assert interaction latency < Nms
     "data persists"    → write, kill the process, relaunch, diff the data
     "safe content"     → feed a banned phrase, assert it is blocked (grep -q)
     "card flips on reveal" → assert the element's rotation / visible face changes
   The ONLY things you may leave UNBUILT are the genuinely INFEASIBLE for this build
   (e.g. camera eye-tracking in a cheap webapp) or irreducibly SUBJECTIVE (a voice's
   "warmth") — and those you SURFACE AS A DECISION (a fork) or flag tier-4 PAIRED
   with a tier-1 proxy. NEVER silently omit an EXPECTED component because it was
   inconvenient to verify — that ships the skeleton, the failure the user resents most.

3. DECISIONS — the open choices this build faces. FIRST, treat every CONSTRAINT and
   NON-GOAL in the input as SETTLED FACT: never surface a decision the input already
   answered. If it says "no brokerages / doesn't want to sign up", brokerages are RULED
   OUT — do not ask "brokerages or crypto"; build the ruled-in path. Re-asking a settled
   constraint as a fork is a failure the user will resent. The ONE exception: a stated
   approach that is ITSELF a security/safety anti-pattern for a sensitive-asset product
   (the safety fork in step 0) is NOT a settled fact to honor silently — surface it as a
   challenge, because shipping the unsafe thing the user offhandedly asked for is the
   worse failure. Then: surface the CRUX technical
   decision — the single hardest, most build-defining fork (for a realtime
   collaborative app, the SYNC model: CRDT / OT / last-write-wins; for a game,
   the netcode) — never skip it to ask something generic like "where to
   deploy". For EACH, assess three booleans HONESTLY — be honest in BOTH
   directions: do not manufacture asks, do not bury a real one.
   - canGuess: would YOUR default be RIGHT, or would you be GUESSING at
     something only the user knows? Split it cleanly:
     * TRUE for TECHNICAL / implementation choices — language, framework,
       database, hosting, algorithm, sync model, data structures. Best practice
       applies; your judgment >= the user's. Default these; never ask.
     * FALSE for anything about the USER'S OWN WORLD — their goals, constraints,
       body, family, situation, and the content / rules / preferences / scope
       that make this THEIRS. You cannot know these; a "typical" default is a
       guess that builds the WRONG thing. ALL of these are canGuess=FALSE: the
       child's age; the user's fitness level and available equipment; their
       dietary restrictions; their budget; which channel or server to watch;
       what words or rules to moderate; their exam dates; which data fields
       predict the outcome. "I can pick something plausible" is NOT "my pick is
       right."
     Most CONSUMER / PERSONAL / TEAM products have 2-4 user-held forks — HUNT
     for them. If a real person would have specific needs here and you surfaced
     ZERO asks, you defaulted something you should have asked.
   - forksHard: do different answers change the COMPONENTS, GATES, or
     ARCHITECTURE? FALSE for cosmetic choices, and FALSE when the answer is just
     a CONFIGURATION VALUE the built thing accepts as input — the code is
     identical, you only pass the value in at runtime. ALL of these are
     config = forksHard FALSE = leave SILENT: a path/name/key/schedule; a
     numeric threshold (retry count, rate limit, file-size cap, timeout,
     false-positive rate, detection range, battery target, flaky %); a tunable
     default value. TRUE only when different answers mean genuinely DIFFERENT
     CODE to build (audio-only vs a visual avatar; one CI format vs several;
     a gate that differs by the child's age; local-only vs cloud-sync storage).
   - costlyToUndo: does this DEFINE a gate, the architecture, or the scope, so a
     wrong default forces a rebuild? FALSE when it is a config knob you can flip
     later cheaply (then default it, even if it is a user-held fact).
   You ASK the user only when ALL THREE line up: you cannot know it, it forks
   the build, and it is costly to undo. Most decisions are defaults; a couple
   are real asks. Give: why (what it changes), recommendation (your default),
   and 1-3 alternatives.

   SCOPE = THE EXPECTED SHAPE, NOT THE MINIMUM. Include what a typical user of this
   kind of product assumes is there (the test: would most users be SURPRISED it's
   missing? → then it is core, not v2). When a fork is "should it ALSO do X" where X
   is a genuine ADD-ON beyond the expected shape (custom habits, past-date editing,
   extra screens), the MVP default is still NO — cut it to v2. But do NOT confuse the
   expected shape with an add-on: a poker table, a playable game, an animated
   character are the PRODUCT, not flexibility. "Tight" means WELL-GATED, not
   amputated; a fully-gated build of the expected shape beats a skeleton that loops.

${GATE_LADDER_DOC}

Output ONLY JSON:
{"stories":["..."],
 "components":[{"statement":"...","story":"...","gate":{"tier":1,"gate":"..."}}],
 "decisions":[{"question":"...","why":"...","recommendation":"...","alternatives":["..."],"canGuess":false,"forksHard":true,"costlyToUndo":true}]}`;

/** Run the idea phase on a prompt; buckets are computed in code from the model's 3-test. */
export async function extractIdea(prompt: string, llm: LlmClient, model: string): Promise<IdeaResult> {
  const res = await llm.complete({ model, system: IDEA_PROMPT, user: `PRODUCT PROMPT:\n${prompt}`, json: true, maxTokens: 4000 });
  const parsed = tryParseJson(res.text);
  if (!parsed.ok) throw new SquireError("IDEA_INVALID", `idea phase produced invalid JSON: ${parsed.error}`);
  const checked = IdeaSchema.safeParse(parsed.value);
  if (!checked.success) throw new SquireError("IDEA_INVALID", `idea phase output failed validation:\n${formatZodIssues(checked.error.issues)}`);
  return {
    stories: checked.data.stories,
    components: checked.data.components,
    decisions: checked.data.decisions.map((d) => ({ ...d, bucket: bucketOf(d) })),
  };
}

const ConverseSchema = IdeaSchema.extend({ reply: z.string().default("") });

const CONVERSE_SYSTEM = `${IDEA_PROMPT}

CONVERSATION MODE. You already produced the breakdown the user is looking at; they just gave FEEDBACK on it. Two jobs, in order:

A) "reply" — RESPOND to their specific point, plain and direct, referencing their ACTUAL words. Be as long as the point genuinely needs: a crisp acknowledgement can be one line, but when you're explaining a real fork, a trade-off, or WHY something matters, give the substance — a short paragraph is welcome. Do NOT pad, and do NOT truncate a real explanation to save space; thin, hand-wavy answers are a failure. ENGAGE: if they call something vague (e.g. "appropriate channels is vague"), NAME what's hiding in it and resolve it — make it concrete, or say it conceals a fork, which one, and what the options actually are. If they ask a question, answer it properly. If you genuinely cannot decide it for them, ask ONE pointed question back and say why it's theirs to call. NEVER a generic "got it, updated" — that is the failure they are complaining about.

B) revise the breakdown so it ACTUALLY reflects your reply. If you made something concrete, the stories/decisions must now show that concreteness — do NOT hand back the wording they just flagged. If their point exposes a user-held fork, ADD it to decisions (canGuess=false). If you asked a question back, leave that part as an open decision rather than guessing.

Output ONLY JSON, now WITH a "reply": {"reply":"…","stories":[...],"components":[...],"decisions":[...]}.`;

/** A conversational turn at the idea layer: ser responds to the user's feedback AND revises
 * the breakdown to reflect that response (never a silent regenerate of the same thing). */
export async function converseIdea(
  prompt: string,
  current: IdeaResult,
  history: { user: string; ser: string }[],
  message: string,
  llm: LlmClient,
  model: string,
): Promise<{ reply: string; idea: IdeaResult }> {
  const user = [
    `PRODUCT PROMPT:\n${prompt}`,
    `THE BREAKDOWN THEY ARE LOOKING AT:\nstories:\n${current.stories.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}\ndecisions:\n${current.decisions.map((d) => `  - ${d.question}`).join("\n") || "  (none)"}`,
    history.length ? `CONVERSATION SO FAR:\n${history.map((h) => `  user: ${h.user}\n  ser: ${h.ser}`).join("\n")}` : "",
    `THE USER NOW SAYS:\n${message}`,
  ].filter(Boolean).join("\n\n");
  const res = await llm.complete({ model, system: CONVERSE_SYSTEM, user, json: true, maxTokens: 4000 });
  const parsed = tryParseJson(res.text);
  const checked = parsed.ok ? ConverseSchema.safeParse(parsed.value) : null;
  if (!checked || !checked.success) return { reply: "Hm — let me try that again; say it once more?", idea: current };
  const d = checked.data;
  return {
    reply: d.reply.trim() || "Updated.",
    idea: { stories: d.stories, components: d.components, decisions: d.decisions.map((x) => ({ ...x, bucket: bucketOf(x) })) },
  };
}

// ===================== IDEA PHASE: outcome-discovery conversation =====================

/** The signed-off handoff to the spec phase: what the user wants to be TRUE, not how to build it. */
export interface OutcomesBrief {
  intent: string;
  outcomes: string[];
  forWhom: string;
  nonGoals: string[];
  constraints: string[];
}
export const EMPTY_BRIEF: OutcomesBrief = { intent: "", outcomes: [], forWhom: "", nonGoals: [], constraints: [] };

const BriefSchema = z.object({
  intent: z.string().default(""),
  outcomes: z.array(z.string()).default([]),
  forWhom: z.string().default(""),
  nonGoals: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
});
const DiscussSchema = z.object({ reply: z.string().default(""), brief: BriefSchema.default({}), ready: z.boolean().default(false) });

const DISCUSS_SYSTEM = `${CASTELLAN_IDENTITY}

You are ser in the IDEA phase — a real conversation, BEFORE any building. Your ONLY job is to understand what the user wants to be TRUE once this exists: their desired TERMINAL OUTCOMES. NOT how to build it. This takes SEVERAL ROUNDS — do not rush to a conclusion or a spec.

HOW TO TALK:
- Reflect what you heard in your own words, then ask ONE good question at a time. Dig into the things that actually define success: what's TRUE when this works? who is it for? what would make it a failure? what's explicitly NOT wanted? any hard constraint?
- Engage their ACTUAL words — riff, push back gently, name a tension or an assumption worth checking. Be a sharp collaborator, not a form to fill in.
- If they raise IMPLEMENTATION (tech, tools, components, "how"), acknowledge briefly and DEFER: "that's the next phase — spec; first let's make sure I've got what you actually want." Do NOT put implementation into the brief.
- DOMAIN CHECK: you build SOFTWARE — apps, sites, services, tools, agents. If a stated outcome is NOT deliverable as software (a physical object, a smell, a taste, a real-world feeling, or a grand aspiration like "connects to the future of humanity"), do NOT silently record it. Say plainly that it's outside what you can build, and either reframe it to the closest software you COULD make (e.g. "I can't make a scented paper wolf, but I could build an app/keepsake site about it — want that?") or ask them to restate the outcome as something software can deliver. NEVER carry un-buildable outcomes into the brief toward a spec. This applies to outcomes ALREADY in your current brief too: if the brief you were handed contains un-buildable outcomes, flag them and REMOVE them now — do not keep them just because they were recorded in an earlier turn.

THE BRIEF (your running understanding — refine it EVERY turn from what they've actually said):
- intent: one line, what they're trying to make, in their words.
- outcomes: the desired terminal outcomes — what is TRUE when this works, in the USER'S terms (not features, not implementation).
- forWhom: who / the context.
- nonGoals: what they've said is out of scope.
- constraints: hard constraints they stated.
AVOIDANCES MATTER AS MUCH AS OUTCOMES: the moment the user says they do NOT want something, want to AVOID it, or won't do it (e.g. "I don't want to use brokerages because I don't want to sign up", "no ads", "must work offline"), capture it IMMEDIATELY in nonGoals or constraints and NEVER drop it on a later turn — it constrains the whole build, and losing it is exactly the failure that makes the next phase ask a question they already answered.
ONLY include what they have actually said or confirmed — NEVER invent outcomes to look complete. Empty lists are fine early on.

READY: keep ready=false until you genuinely understand the outcomes well enough that a spec could be built without guessing at anything load-bearing. When you get there, set ready=true and your reply should reflect the brief back and offer to move to spec.

"reply" is your conversational turn: substantive, engages their words, asks the next real question (or reflects + proposes moving on when ready). Output ONLY JSON: {"reply":"…","brief":{"intent":"…","outcomes":[],"forWhom":"…","nonGoals":[],"constraints":[]},"ready":false}.`;

/** One turn of the idea-phase conversation: ser responds AND updates its running understanding
 * of the user's desired terminal outcomes. No breakdown, no implementation — that's spec. */
export async function discussIdea(
  history: { user: string; ser: string }[],
  message: string,
  current: OutcomesBrief,
  llm: LlmClient,
  model: string,
): Promise<{ reply: string; brief: OutcomesBrief; ready: boolean }> {
  const user = [
    history.length ? `CONVERSATION SO FAR:\n${history.map((h) => `  user: ${h.user}\n  ser: ${h.ser}`).join("\n")}` : "",
    `YOUR CURRENT BRIEF (refine, don't reset):\n${JSON.stringify(current)}`,
    `THE USER NOW SAYS:\n${message}`,
  ].filter(Boolean).join("\n\n");
  const res = await llm.complete({ model, system: DISCUSS_SYSTEM, user, json: true, maxTokens: 3000 });
  const parsed = tryParseJson(res.text);
  const checked = parsed.ok ? DiscussSchema.safeParse(parsed.value) : null;
  if (!checked || !checked.success) return { reply: "Say a bit more about what you're picturing — what should be true once this exists?", brief: current, ready: false };
  return { reply: checked.data.reply.trim() || "Tell me more.", brief: checked.data.brief, ready: checked.data.ready };
}

/** Flatten the approved brief into the rich prompt the spec phase's breakdown consumes. */
export function briefToText(b: OutcomesBrief): string {
  return [
    b.intent && `INTENT: ${b.intent}`,
    b.forWhom && `FOR: ${b.forWhom}`,
    b.outcomes.length ? `DESIRED TERMINAL OUTCOMES (what must be true when it works):\n${b.outcomes.map((o) => `- ${o}`).join("\n")}` : "",
    b.constraints.length ? `CONSTRAINTS:\n${b.constraints.map((c) => `- ${c}`).join("\n")}` : "",
    b.nonGoals.length ? `NON-GOALS (explicitly out of scope — do not build these):\n${b.nonGoals.map((n) => `- ${n}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

/** Human-readable rendering for `ser idea` and live validation. */
export function renderIdea(r: IdeaResult): string[] {
  const out: string[] = [];
  out.push(`STORIES (${r.stories.length}):`);
  r.stories.forEach((s, i) => out.push(`  ${i + 1}. ${s}`));
  out.push(`\nCOMPONENTS / minimum viable (${r.components.length}):`);
  for (const c of r.components) out.push(`  [t${c.gate.tier}] ${c.statement}${c.story ? `  ← ${c.story}` : ""}`);
  const ask = r.decisions.filter((d) => d.bucket === 1);
  const auto = r.decisions.filter((d) => d.bucket === 2);
  const trivia = r.decisions.filter((d) => d.bucket === 3);
  out.push(`\nDECISIONS — ${ask.length} ask, ${auto.length} default, ${trivia.length} silent:`);
  for (const d of ask) out.push(`  [ASK]  ${d.question}\n         why: ${d.why}\n         recommend: ${d.recommendation}${d.alternatives.length ? `  | alts: ${d.alternatives.join(", ")}` : ""}`);
  for (const d of auto) out.push(`  [auto] ${d.question} → ${d.recommendation}`);
  if (trivia.length) out.push(`  [silent] ${trivia.map((d) => d.question).join("; ")}`);
  return out;
}
