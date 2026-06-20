/**
 * The four spec reviewers (gstack CEO / Design / Eng / DX), Phase 2. Each is ONE
 * premium LLM call carrying its verbatim principle block; it scores its
 * dimensions 0-10, emits patches (each a runnable shell gate), and classifies the
 * decisions it can't settle. zod safeParse with an empty/null fallback — exactly
 * like reviewSpec in src/contract/review.ts — so a malformed model reply degrades
 * to "no findings" rather than throwing. The orchestrator does no LLM work, so
 * these are the only model-dependent pieces and they are MockLlm-testable.
 */
import { z } from "zod";
import type { LlmClient } from "../llm/types.js";
import type { Spec } from "../contract/spec.js";
import { tryParseJson } from "../contract/derive.js";
import { ReviewerResultSchema, type ReviewerResult } from "./types.js";
import { DESIGN_REVIEW_SYSTEM } from "./prompts.js";

export type ReviewerName = ReviewerResult["reviewer"];

/** The model returns everything except `reviewer` — that is fixed per function. */
const ReviewerOutputSchema = ReviewerResultSchema.omit({ reviewer: true });

/** The spec the reviewers read, capped to the fields a review needs. */
export interface ReviewSpecInput {
  thesis: string;
  stories: string[];
  requirements: { id: string; statement: string; acceptance: { tier: number; gate?: string; artifact?: string } }[];
}

/** Accept a full Spec or the trimmed shape; both expose thesis/stories/requirements. */
function toInput(spec: Spec | ReviewSpecInput): ReviewSpecInput {
  return { thesis: spec.thesis, stories: spec.stories, requirements: spec.requirements };
}

function emptyResult(reviewer: ReviewerName): ReviewerResult {
  return { reviewer, overall: 0, dimensions: [], patches: [], decisions: [] };
}

/** Render the spec for a reviewer — same shape reviewSpec used (thesis + stories + tiered requirements). */
function specToUser(spec: ReviewSpecInput): string {
  const tier = (a: ReviewSpecInput["requirements"][number]["acceptance"]): string =>
    a.gate ? "gated" : a.artifact ? "artifact" : "UNGATED";
  return [
    `THESIS: ${spec.thesis}`,
    `STORIES:\n${spec.stories.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`,
    `REQUIREMENTS:\n${spec.requirements
      .map((r) => `  ${r.id} [tier ${r.acceptance.tier} ${tier(r.acceptance)}] ${r.statement}`)
      .join("\n")}`,
  ].join("\n\n");
}

/** One reviewer call: premium model, JSON, safeParse, empty fallback on any failure. */
async function runReviewer(
  reviewer: ReviewerName,
  system: string,
  spec: Spec | ReviewSpecInput,
  llm: LlmClient,
  model: string,
): Promise<ReviewerResult> {
  let res: { text: string };
  try {
    res = await llm.complete({ model, system, user: specToUser(toInput(spec)), json: true, maxTokens: 3500 });
  } catch {
    return emptyResult(reviewer);
  }
  const parsed = tryParseJson(res.text);
  if (!parsed.ok) return emptyResult(reviewer);
  const checked = ReviewerOutputSchema.safeParse(parsed.value);
  if (!checked.success) return emptyResult(reviewer);
  return { reviewer, ...checked.data };
}

// Only the design reviewer survives the streamline — the refold loop uses it to turn
// rebuild fix-stories into objective gates. The ceo/eng/dx reviewers + their
// orchestration were the multi-reviewer committee and were deleted.
export function designReview(spec: Spec | ReviewSpecInput, llm: LlmClient, model: string): Promise<ReviewerResult> {
  return runReviewer("design", DESIGN_REVIEW_SYSTEM, spec, llm, model);
}

/** Re-exported for the orchestrator + tests: the validating schema for a model reply. */
export { ReviewerOutputSchema };

// Keep zod import referenced even when this module is tree-shaken to the schemas.
export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;
