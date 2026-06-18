/**
 * visual-eval — does the live visual review CATCH known design defects (e.g.
 * clairvoyance's missing "size" + bare AI-slop UI) and BLOCK ship, without
 * blocking a clean control?
 *
 *   pnpm visual-eval
 *
 * LIVE: needs OPENROUTER_API_KEY (multimodal judge) + a headless Chrome/Chromium.
 * Success gate: every defective fixture blocked + its defects caught (recall >=
 * 0.75), zero control false-positives.
 */
import { makeVisualClient } from "../src/backend.js";
import { renderBuild, visualReview, blockingFixes } from "../src/review/visual.js";
import { scoreVisualVerdict, gateVisualEval, type VisualEvalScore } from "../src/eval/visual-eval.js";
import { VISUAL_FIXTURES } from "../specs/review-set/labels.js";

async function main(): Promise<number> {
  const vc = await makeVisualClient();
  if (!vc) {
    process.stderr.write("OPENROUTER_API_KEY required for the multimodal visual judge.\n");
    return 1;
  }
  process.stderr.write(`visual judge model: ${vc.model}\n`);

  const scores: VisualEvalScore[] = [];
  for (const fx of VISUAL_FIXTURES) {
    const shot = await renderBuild(fx.buildDir);
    if (!shot.ok) {
      process.stderr.write(`✗ ${fx.id}: render failed — ${shot.note}\n`);
      return 1;
    }
    const verdict = await visualReview(shot, fx.spec, vc.llm, vc.model);
    if (!verdict) {
      process.stderr.write(`✗ ${fx.id}: visual judge returned no verdict\n`);
      return 1;
    }
    const s = scoreVisualVerdict(fx, verdict);
    scores.push(s);
    const fixes = blockingFixes(verdict);
    process.stdout.write(
      `${fx.isControl ? "[control]" : "[defect ]"} ${fx.id.padEnd(16)} ` +
        `recall ${(s.recall * 100).toFixed(0)}%  blocking ${fixes.length}  ` +
        `caught[${s.caught.join(",")}]  missed[${s.missed.join(",")}]\n`,
    );
  }

  const g = gateVisualEval(scores, VISUAL_FIXTURES);
  process.stdout.write(
    `\nGATE: ${g.passed ? "PASS" : "FAIL"} — recall ${(g.defectRecall * 100).toFixed(0)}%, ` +
      `defective blocked ${g.defectiveBlocked}/${g.defectiveTotal}, control false-positives ${g.falsePositives}\n`,
  );
  return g.passed ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
