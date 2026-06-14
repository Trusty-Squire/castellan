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

1. USER STORIES — the FEWEST stories that capture the CORE: the things without
   which this is not the product. A simple tool may have just 2-3; do NOT pad
   to 5. EXCLUDE nice-to-haves, v2 features, and edge cases — they are "later",
   not minimum-viable (a URL shortener is shorten + redirect; "report a
   malicious URL" is later; a to-do app is add + complete + view, not edit).
   Concrete and observable, in plain words ("she asks a question and gets a
   kid-safe answer"). Uses, not features.

2. COMPONENTS — for each story, the component(s) it requires. The UNION is the
   minimum build. Give each an OBJECTIVE gate: a tier-1 SHELL COMMAND a machine
   runs to prove it works (exit 0 = pass). This is the WHOLE product — the spec
   must LOOP UNATTENDED, so a gate a human has to eyeball is a FAILURE, not an
   option. Almost everything reduces to a command — HUNT for it:
     "feels responsive" → assert interaction latency < Nms
     "data persists"    → write, kill the process, relaunch, diff the data
     "safe content"     → feed a banned phrase, assert it is blocked (grep -q)
     "readable for a 4yo"→ grep the rendered font-size / contrast / button size
   Use tier-4 (human-reviewed artifact) ONLY for an irreducibly subjective
   property, and even then PAIR it with a tier-1 proxy. NEVER tier-4 alone, and
   NEVER tier-4 for something a command could check. A tier-4 gate you could
   have written as a command is the cardinal sin of this product.

3. DECISIONS — the open choices this build faces. Surface the CRUX technical
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

   SCOPE IS SUBTRACTION. When a fork is "should it ALSO do X" (custom habits,
   past-date editing, extra screens), the MVP default is NO — cut it to v2.
   Recommend the SMALLER build every time; a tight, fully-gated v1 that loops is
   worth more than a rich one that doesn't. Never expand scope to be "flexible".

${GATE_LADDER_DOC}

Output ONLY JSON:
{"stories":["..."],
 "components":[{"statement":"...","story":"...","gate":{"tier":1,"gate":"..."}}],
 "decisions":[{"question":"...","why":"...","recommendation":"...","alternatives":["..."],"canGuess":false,"forksHard":true,"costlyToUndo":true}]}`;

/** Run the idea phase on a prompt; buckets are computed in code from the model's 3-test. */
export async function extractIdea(prompt: string, llm: LlmClient, model: string): Promise<IdeaResult> {
  const res = await llm.complete({ model, system: IDEA_PROMPT, user: `PRODUCT PROMPT:\n${prompt}`, json: true, maxTokens: 2500 });
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
