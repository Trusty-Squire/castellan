import { evaluateDecompositionReliability, renderDecompositionEvalReport } from "../src/eval/decomposition.js";

evaluateDecompositionReliability().then((report) => {
  process.stdout.write(renderDecompositionEvalReport(report) + "\n");
  process.exit(report.targetPassed ? 0 : 1);
}).catch((err: unknown) => {
  process.stderr.write(`decomposition-eval error: ${(err as Error).message}\n`);
  process.exit(1);
});
