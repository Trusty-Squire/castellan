import { z } from "zod";
import type { LlmClient } from "../llm/types.js";
import type { Spec } from "./spec.js";
import { tryParseJson } from "./derive.js";

/**
 * The funnel's review lenses, borrowed from gstack's plan-eng-review and
 * plan-design-review. Two uses:
 *   L2 (reviewSpec): apply the lenses to the draft spec BEFORE building —
 *     surface the forks that need genuine human judgment / can't be objectively
 *     gated (these become open_questions), plus eng/design notes.
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

const SPEC_REVIEW_SYSTEM = `You are ser's spec reviewer. You apply two lenses to a draft product spec, like a senior engineer and a senior designer reviewing a plan before code is written.
ENGINEERING lens: ${ENG_LENS}.
DESIGN lens: ${DESIGN_LENS}.

Your job is to CLOSE GAPS, not to surface them. For every gap, missing requirement, unhandled edge case, or obvious design improvement you find, DECIDE THE SANE DEFAULT YOURSELF and emit it as a "patch": a new requirement statement plus a runnable shell gate that verifies it (exit 0 = pass). Prefer patching. A patch is right whenever a competent engineer would make the same call without asking — empty/loading/error states, input validation, a missing test, an obvious accessibility fix, a sensible limit. Make the decision; don't punt it.

ONLY escalate to an open_question when the choice GENUINELY needs the user — reasonable people would choose differently AND no cheap automatic test settles it (a product/taste/risk tradeoff that's the user's to own). Mark blocking:true only if building the wrong way is costly to undo. Most reviews should have several patches and zero or one open_question.

Every open_question WILL BE ASKED to the user as a multiple-choice pick, so for each one supply "options": 2-4 concrete candidate answers they can choose between (NOT vague directions — real, buildable choices, e.g. for risk limits: "Max 20% per position, stop-loss at -5%, 3 trades/day"). Put the sane default / your recommendation FIRST. Phrase "text" as a direct question.

Each gate must be a real shell command that exits 0 on success (e.g. "grep -q 'aria-label' index.html", "test -f tests/empty-state.test.js && npm test -- empty-state"). Output ONLY JSON: {"patches":[{"statement":"…","gate":"…"}],"open_questions":[{"text":"…","options":["recommended answer","alternative"],"blocking":false}]}. Keep patches to the 1-6 highest-value gaps. Empty lists are fine.`;

export async function reviewSpec(spec: Spec, llm: LlmClient, model: string): Promise<SpecReview> {
  const user = [
    `THESIS: ${spec.thesis}`,
    `STORIES:\n${spec.stories.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`,
    `REQUIREMENTS:\n${spec.requirements
      .map((r) => `  ${r.id} [tier ${r.acceptance.tier}${r.acceptance.gate ? " gated" : r.acceptance.artifact ? " artifact" : " UNGATED"}] ${r.statement}`)
      .join("\n")}`,
  ].join("\n\n");
  const res = await llm.complete({ model, system: SPEC_REVIEW_SYSTEM, user, json: true, maxTokens: 3000 });
  const parsed = tryParseJson(res.text);
  if (!parsed.ok) return { patches: [], open_questions: [] };
  const checked = SpecReviewSchema.safeParse(parsed.value);
  return checked.success ? checked.data : { patches: [], open_questions: [] };
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

export async function auditBuild(
  files: { path: string; src: string }[],
  spec: { thesis: string; stories: string[] },
  llm: LlmClient,
  model: string,
  maxBytes = 60000,
): Promise<Audit> {
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
  const res = await llm.complete({ model, system: AUDIT_SYSTEM, user, json: true, maxTokens: 3500 });
  const parsed = tryParseJson(res.text);
  if (!parsed.ok) return { recommendations: [] };
  const checked = AuditSchema.safeParse(parsed.value);
  return checked.success ? checked.data : { recommendations: [] };
}
