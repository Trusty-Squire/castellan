import { evaluatePlannerFrontDoor, renderPlannerEvalReport } from "../src/eval/planner.js";

evaluatePlannerFrontDoor().then((report) => {
  process.stdout.write(renderPlannerEvalReport(report) + "\n");
  process.exit(report.targetPassed ? 0 : 1);
}).catch((err: unknown) => {
  process.stderr.write(`planner-eval error: ${(err as Error).message}\n`);
  process.exit(1);
});
