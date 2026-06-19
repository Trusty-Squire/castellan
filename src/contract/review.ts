import { z } from "zod";
import type { LlmClient } from "../llm/types.js";
import type { Spec } from "./spec.js";
import { tryParseJson } from "./derive.js";
import { reviewPlan } from "../review/orchestrate.js";
import type { ReviewDecision } from "../review/types.js";
import { withFrontendFloorStories } from "../review/frontend-floor.js";

/**
 * The funnel's review lenses, borrowed from gstack's plan-* reviews. Two uses:
 *   L2 (reviewSpec): NOW a thin adapter over the Phase-2 multi-reviewer pipeline
 *     (src/review/orchestrate.ts → ceo/design/eng/dx). It maps the rich
 *     PipelineResult back to the original {patches, open_questions} shape so
 *     cli.ts/app.ts consumers need zero change: objective patches become gated
 *     requirements, the single final gate (taste + user_challenge) becomes
 *     open_questions.
 *   L4 (auditBuild): independent reviewers with NO build memory read the
 *     finished code against the spec and return polish recommendations.
 */

const ENG_LENS =
  "architecture & data flow; edge cases & failure modes; test/eval coverage (does every requirement have a RUNNABLE gate, or is it only checkable by a human?); performance; security & safety";
const DESIGN_LENS =
  "information hierarchy; user flow & friction; the empty / loading / error states; visual clarity & consistency; accessibility; one moment of delight";

// ---------- L2: review the spec, surface judgment-only forks ----------

const SpecReviewSchema = z.object({
  patches: z
    .array(z.object({ statement: z.string().min(1), gate: z.string().min(1) }))
    .default([]),
  open_questions: z
    .array(
      z.object({
        text: z.string().min(1),
        // Candidate answers, so a genuine judgment call is ASKED as a pick — not
        // dumped as a passive note. First entry is the sane default / recommended.
        options: z.array(z.string().min(1)).default([]),
        blocking: z.boolean().default(false),
      }),
    )
    .default([]),
});
export type SpecReview = z.infer<typeof SpecReviewSchema>;

/**
 * Adapter: run the full ceo/design/eng/dx pipeline, then collapse it to the
 * legacy shape. Objective patches → gated requirements (the cli/tui push these as
 * tier-1 checks); the single final gate (taste + user_challenge) → open_questions
 * the human is asked. Visual patches are dropped here — they belong to the live
 * audit-layer judge, not the spec-stage adapter. Degrades to empty on any failure.
 */
export async function reviewSpec(spec: Spec, llm: LlmClient, model: string): Promise<SpecReview> {
  const pipeline = await reviewPlan(withFrontendFloorStories(spec), llm, model);
  const patches = pipeline.patches
    .filter((p) => p.kind === "objective")
    .map((p) => ({ statement: p.statement, gate: p.gate }));
  const open_questions = pipeline.finalGate.map((d) => ({
    text: d.text,
    options: orderedOptions(d),
    // a user_challenge is always blocking — the plan and the reviewer both think
    // the user's stated direction is wrong, so it must not slip through silently.
    blocking: d.blocking || d.classification === "user_challenge",
  }));
  const checked = SpecReviewSchema.safeParse({ patches, open_questions });
  return checked.success ? checked.data : { patches: [], open_questions: [] };
}

/** Recommendation first (de-duped) so the cli/tui multiple-choice pick defaults to it. */
function orderedOptions(d: ReviewDecision): string[] {
  if (!d.recommendation) return d.options;
  return [d.recommendation, ...d.options.filter((o) => o !== d.recommendation)];
}

// ---------- L4: audit the built code, independent of the builder ----------

const AuditSchema = z.object({
  recommendations: z
    .array(
      z.object({
        lens: z.enum(["eng", "design", "dogfood"]),
        severity: z.enum(["high", "med", "low"]),
        note: z.string().min(1),
        file: z.string().optional(),
      }),
    )
    .default([]),
});
export type Audit = z.infer<typeof AuditSchema>;

const AUDIT_SYSTEM = `You are ser's audit reviewer. You have NO memory of how this was built — you see only the finished code and the spec it was meant to satisfy, with completely fresh eyes. Apply three lenses and report concrete, actionable polish:
ENGINEERING: ${ENG_LENS}.
DESIGN: ${DESIGN_LENS}.
DOGFOOD: actually trace a user doing each story end to end — where would a real user hit friction, confusion, or a rough edge?

Report only things that are real and worth fixing. For each, give the lens, a severity (high/med/low), a one-sentence concrete note, and the file if applicable. Do NOT restate what works. Output ONLY JSON: {"recommendations":[{"lens":"eng","severity":"med","note":"…","file":"app.js"}]}.`;

const DEFAULT_AUDIT_TIMEOUT_MS = 45_000;

export async function auditBuild(
  files: { path: string; src: string }[],
  spec: { thesis: string; stories: string[] },
  llm: LlmClient,
  model: string,
  maxBytes = 60000,
  timeoutMs = DEFAULT_AUDIT_TIMEOUT_MS,
): Promise<Audit> {
  spec = withFrontendFloorStories(spec);
  // pack the code, capped, so the reviewer sees the whole product cheaply.
  let budget = maxBytes;
  const packed: string[] = [];
  for (const f of files) {
    const block = `--- ${f.path} ---\n${f.src}\n`;
    if (block.length > budget) { packed.push(`--- ${f.path} --- (truncated)\n${f.src.slice(0, budget)}\n`); break; }
    packed.push(block);
    budget -= block.length;
  }
  const user = [
    `THESIS: ${spec.thesis}`,
    `STORIES (each should work end to end):\n${spec.stories.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`,
    `CODE:\n${packed.join("\n")}`,
  ].join("\n\n");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer.unref?.();
  let res: Awaited<ReturnType<LlmClient["complete"]>>;
  try {
    res = await llm.complete({ model, system: AUDIT_SYSTEM, user, json: true, maxTokens: 3500, signal: ac.signal });
  } catch {
    return { recommendations: [] };
  } finally {
    clearTimeout(timer);
  }
  const parsed = tryParseJson(res.text);
  if (!parsed.ok) return { recommendations: [] };
  const checked = AuditSchema.safeParse(parsed.value);
  return checked.success ? checked.data : { recommendations: [] };
}
