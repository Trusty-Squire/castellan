/**
 * gate-strength — every UX gate must PASS a complete impl and FAIL the incomplete
 * (defective) one. A gate that passes the size-less impl is too weak — that is the
 * clairvoyance failure mode.
 *
 *   pnpm gate-strength
 *
 * The core check is LLM-FREE (runs the shipped UX gates against complete/incomplete
 * fixtures). With OPENROUTER_API_KEY it ALSO asks the design reviewer to author
 * gates for the clairvoyance spec and confirms at least one GENERATED gate fails
 * the incomplete impl — proof the reviewer writes gates with teeth.
 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { OpenRouterClient } from "../src/llm/openrouter.js";
import { designReview } from "../src/review/reviewers.js";
import { checkGateStrength, gateGateStrength, generatedGateFailsIncomplete, type GateStrengthResult } from "../src/eval/gate-strength.js";
import { UX_GATE_CASES } from "../specs/review-set/gate-strength/gate-labels.js";
import { SPEC_FIXTURES } from "../specs/review-set/spec-labels.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const INCOMPLETE_DASHBOARD = join(HERE, "..", "specs", "review-set", "gate-strength", "dashboard", "incomplete");

async function main(): Promise<number> {
  // ---- core: shipped UX gates vs complete/incomplete fixtures (no LLM) ----
  const results: GateStrengthResult[] = [];
  for (const c of UX_GATE_CASES) results.push(await checkGateStrength(c));
  for (const r of results) {
    process.stdout.write(`${r.strong ? "✓" : "✗"} ${r.tag.padEnd(18)} ${r.detail}\n`);
  }
  const g = gateGateStrength(results);
  process.stdout.write(`\nshipped UX gates: ${g.strong}/${g.total} strong${g.weak.length ? ` — weak: ${g.weak.join(",")}` : ""}\n`);
  let pass = g.passed;

  // ---- live: a gate the design reviewer GENERATES must also fail the defect ----
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey) {
    const model = process.env.SER_REVIEW_MODEL ?? "z-ai/glm-5.2";
    const clair = SPEC_FIXTURES.find((f) => f.id === "clairvoyance/design")!;
    const review = await designReview(clair.spec, new OpenRouterClient({ apiKey, baseUrl: process.env.OPENROUTER_BASE_URL }), model);
    const objectiveGates = review.patches.filter((p) => p.kind === "objective").map((p) => p.gate);
    let withTeeth = 0;
    for (const gate of objectiveGates) {
      if (await generatedGateFailsIncomplete(gate, INCOMPLETE_DASHBOARD)) withTeeth += 1;
    }
    process.stdout.write(
      `\ngenerated gates: ${objectiveGates.length} objective, ${withTeeth} fail the incomplete dashboard impl (have teeth)\n`,
    );
    // require the reviewer to author at least one gate with teeth against the defect.
    pass &&= withTeeth >= 1;
  } else {
    process.stdout.write("\n(no OPENROUTER_API_KEY — skipped the generated-gate teeth check)\n");
  }

  process.stdout.write(`\nGATE: ${pass ? "PASS" : "FAIL"}\n`);
  return pass ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
