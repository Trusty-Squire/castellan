import { evaluateDeriveReliability, renderDeriveEvalReport } from "../src/eval/derive.js";

evaluateDeriveReliability().then((report) => {
  process.stdout.write(renderDeriveEvalReport(report) + "\n");
  process.exit(report.targetPassed ? 0 : 1);
}).catch((err: unknown) => {
  process.stderr.write(`derive-eval error: ${(err as Error).message}\n`);
  process.exit(1);
});
