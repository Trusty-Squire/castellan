/**
 * review-eval — does each spec reviewer CATCH known spec defects (recall) without
 * over-flagging clean controls (precision)?
 *
 *   pnpm review-eval
 *
 * LIVE: needs OPENROUTER_API_KEY (premium reviewers). Success gate: the DESIGN
 * reviewer catches all 4 clairvoyance defects with <=1 control false-positive;
 * ceo/eng recall >= 0.75 and precision >= 0.8; dx self-skips (non-dev product).
 * Override the model with SER_REVIEW_MODEL.
 */
import { OpenRouterClient } from "../src/llm/openrouter.js";
import { ceoReview, designReview, engReview, dxReview } from "../src/review/reviewers.js";
import {
  scoreReviewerResult,
  gateReviewEval,
  type ReviewerName,
  type ReviewEvalScore,
  type ReviewEvalThresholds,
} from "../src/eval/review-eval.js";
import { SPEC_FIXTURES } from "../specs/review-set/spec-labels.js";

const FN = { ceo: ceoReview, design: designReview, eng: engReview, dx: dxReview } as const;

const THRESHOLDS: Record<ReviewerName, ReviewEvalThresholds> = {
  design: { minRecall: 1, maxControlFalsePositives: 1 },
  ceo: { minRecall: 0.75, minPrecision: 0.8 },
  eng: { minRecall: 0.75, minPrecision: 0.8 },
  dx: { minRecall: 0.75, minPrecision: 0.8 },
};

async function main(): Promise<number> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    process.stderr.write("OPENROUTER_API_KEY required — review-eval is a LIVE measurement (the human runs it)\n");
    return 1;
  }
  const llm = new OpenRouterClient({ apiKey, baseUrl: process.env.OPENROUTER_BASE_URL });
  const model = process.env.SER_REVIEW_MODEL ?? "anthropic/claude-opus-4";
  process.stderr.write(`review model: ${model}\n`);

  const scores: ReviewEvalScore[] = [];
  for (const fx of SPEC_FIXTURES) {
    const result = await FN[fx.reviewer](fx.spec, llm, model);
    const s = scoreReviewerResult(fx, result);
    scores.push(s);
    process.stdout.write(
      `${fx.isControl ? "[control]" : "[defect ]"} ${fx.id.padEnd(20)} ` +
        `recall ${(s.recall * 100).toFixed(0)}%  caught[${s.caught.join(",")}]  ` +
        `missed[${s.missed.join(",")}]  FP[${s.falsePositives.join(",")}]\n`,
    );
  }

  let allPass = true;
  for (const reviewer of ["ceo", "design", "eng", "dx"] as const) {
    const g = gateReviewEval(reviewer, scores, THRESHOLDS[reviewer]);
    allPass &&= g.passed;
    process.stdout.write(
      `\n${reviewer.toUpperCase().padEnd(7)} ${g.passed ? "PASS" : "FAIL"} — ` +
        `recall ${(g.recall * 100).toFixed(0)}%, precision ${(g.precision * 100).toFixed(0)}%, ` +
        `control FP ${g.controlFalsePositives}`,
    );
  }
  process.stdout.write(`\n\nGATE: ${allPass ? "PASS" : "FAIL"}\n`);
  return allPass ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
