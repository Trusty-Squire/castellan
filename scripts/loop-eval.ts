/**
 * Product-loop eval: measures whether SER behaves like a durable autonomous
 * verification loop after the initial goal, instead of requiring repeated human
 * steering through generated paths and debug internals.
 *
 *   pnpm build
 *   pnpm loop-eval [--cases eval/ser-loop/cases.yaml] [--keep]
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import {
  evaluateLoopSuite,
  loadLoopEvalSuite,
  renderLoopEvalReport,
  type CommandResult,
  type LoopEvalCase,
  type LoopEvalDriver,
} from "../src/eval/loop.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

class SerBinaryDriver implements LoopEvalDriver {
  constructor(private readonly bin: string) {}

  async status(cwd: string): Promise<CommandResult> {
    return this.run(["status"], cwd);
  }

  async continue(cwd: string): Promise<CommandResult> {
    const dryRunPath = join(mkdtempSync(join(tmpdir(), "ser-loop-resume-")), "resume.json");
    const result = await this.run(["continue"], cwd, { SER_RESUME_DRY_RUN_PATH: dryRunPath });
    if (existsSync(dryRunPath)) {
      result.resumePlan = JSON.parse(readFileSync(dryRunPath, "utf8"));
    }
    return result;
  }

  private async run(args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<CommandResult> {
    const result = await execa(process.execPath, [this.bin, ...args], {
      cwd,
      reject: false,
      env: { ...process.env, ...extraEnv, NO_COLOR: "1" },
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}

async function main(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const suitePath = resolve(flags.value.get("cases") ?? join(ROOT, "eval", "ser-loop", "cases.yaml"));
  const bin = resolve(flags.value.get("bin") ?? join(ROOT, "dist", "cli.js"));
  const keep = flags.bool.has("keep");
  const suite = loadLoopEvalSuite(suitePath);
  const roots: string[] = [];
  const report = await evaluateLoopSuite(
    suite,
    (testCase: LoopEvalCase) => {
      const root = mkdtempSync(join(tmpdir(), `ser-loop-${testCase.id}-`));
      roots.push(root);
      return root;
    },
    new SerBinaryDriver(bin),
  );

  process.stdout.write(renderLoopEvalReport(report) + "\n");
  if (keep) {
    process.stdout.write("\nkept eval workdirs:\n" + roots.map((r) => `  ${r}`).join("\n") + "\n");
  } else {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
  return report.targetPassed ? 0 : 1;
}

function parseFlags(args: string[]): { bool: Set<string>; value: Map<string, string> } {
  const bool = new Set<string>();
  const value = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "cases" || key === "bin") value.set(key, args[++i] ?? "");
    else bool.add(key);
  }
  return { bool, value };
}

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err: unknown) => {
  process.stderr.write(`loop-eval error: ${(err as Error).message}\n`);
  process.exit(1);
});
