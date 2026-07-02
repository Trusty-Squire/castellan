/**
 * Live SER product eval.
 *
 * This spends provider tokens and runs the real derive/build ladder. It is
 * intentionally outside `pnpm test`.
 *
 *   pnpm build
 *   pnpm live-eval [--only notes,express,bot] [--keep]
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

interface LiveCase {
  id: string;
  budgetUsd: number;
  spec: string;
}

interface CaseResult {
  id: string;
  ok: boolean;
  deriveExit: number;
  runExit: number | null;
  fallback: boolean;
  tracePath: string | null;
  workdir: string;
  deriveLog: string;
  runLog: string | null;
  stageFail: string;
  durationMs: number;
  costUsd: string;
  note: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  failed: boolean;
}

const CASES: LiveCase[] = [
  {
    id: "notes",
    budgetUsd: 1,
    spec: `
thesis: Build a tiny local notes CLI
stories:
  - I can add a note and list it later from local storage
scope_fence: []
requirements:
  - id: R1
    statement: The notes CLI supports add and list commands backed by a local notes.json store
    acceptance:
      tier: 1
      gate: node notes.js add "hello" && node notes.js list | grep -q hello
decisions: []
claims: []
open_questions: []
`.trimStart(),
  },
  {
    id: "express",
    budgetUsd: 1.2,
    spec: `
thesis: Build a small Express JSON echo service
stories:
  - I can POST JSON over HTTP and receive the same message back
scope_fence:
  - Use a single Node.js server file; no database or external service
requirements:
  - id: R1
    statement: The service exposes POST /echo on a local HTTP server and replies with the posted message
    acceptance:
      tier: 1
      gate: PORT=8787 node server.js & pid=$!; trap 'kill $pid 2>/dev/null || true' EXIT; for i in 1 2 3 4 5; do curl -fsS http://localhost:8787/health >/dev/null 2>&1 && break || sleep 1; done; curl -fsS -X POST http://localhost:8787/echo -H 'content-type: application/json' -d '{"message":"ship"}' | grep -q ship
decisions: []
claims: []
open_questions: []
`.trimStart(),
  },
  {
    id: "bot",
    budgetUsd: 1,
    spec: `
thesis: Build a local mock Telegram-style reply bot module
stories:
  - I can pass an incoming message JSON object and receive a contextual reply JSON object
scope_fence:
  - Do not call the real Telegram API; implement the local message handling module only
requirements:
  - id: R1
    statement: The bot module exports handleUpdate(update) and returns a reply containing chat_id and text derived from the incoming message
    acceptance:
      tier: 1
      gate: node -e "const {handleUpdate}=require('./bot.js'); Promise.resolve(handleUpdate({message:{chat:{id:42},text:'nervous before date'}})).then(r=>{ if(r.chat_id!==42 || !/date|nervous|reply/i.test(r.text)) process.exit(1); })"
decisions: []
claims: []
open_questions: []
`.trimStart(),
  },
];

async function main(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const keep = flags.bool.has("keep");
  const only = new Set((flags.value.get("only") ?? CASES.map((c) => c.id).join(",")).split(",").map((s) => s.trim()).filter(Boolean));
  const bin = resolve(flags.value.get("bin") ?? join(ROOT, "dist", "cli.js"));
  const chain = flags.value.get("chain") ?? "cheap";
  const plannerTimeoutMs = flags.value.get("planner-timeout-ms") ?? "90000";
  const rungTimeoutMs = flags.value.get("rung-timeout-ms") ?? "90000";
  const caseTimeoutMs = Number(flags.value.get("case-timeout-ms") ?? "420000");
  if (!existsSync(bin)) throw new Error(`CLI not built at ${bin}; run pnpm build or pass --bin`);

  const selected = CASES.filter((c) => only.has(c.id));
  const results: CaseResult[] = [];
  for (const testCase of selected) {
    process.stderr.write(`[live-eval] ${testCase.id}: starting (planner=${plannerTimeoutMs}ms rung=${rungTimeoutMs}ms case=${caseTimeoutMs}ms)\n`);
    results.push(await runCase(testCase, { bin, chain, plannerTimeoutMs, rungTimeoutMs, caseTimeoutMs }));
    const last = results[results.length - 1]!;
    process.stderr.write(`[live-eval] ${testCase.id}: ${last.ok ? "pass" : "fail"} in ${Math.round(last.durationMs / 1000)}s (${last.workdir})\n`);
  }

  process.stdout.write(renderReport(results) + "\n");
  if (!keep) {
    for (const r of results) rmSync(r.workdir, { recursive: true, force: true });
  } else {
    process.stdout.write("\nkept workdirs:\n" + results.map((r) => `  ${r.id}: ${r.workdir}`).join("\n") + "\n");
  }
  return results.every((r) => r.ok) ? 0 : 1;
}

async function runCase(
  testCase: LiveCase,
  opts: { bin: string; chain: string; plannerTimeoutMs: string; rungTimeoutMs: string; caseTimeoutMs: number },
): Promise<CaseResult> {
  const started = Date.now();
  const workdir = mkdtempSync(join(tmpdir(), `ser-live-${testCase.id}-`));
  const specPath = join(workdir, "spec.yaml");
  const missionPath = join(workdir, "mission.yaml");
  const stageFailPath = join(workdir, "derive-stage-fail.txt");
  const deriveLogPath = join(workdir, "derive.log");
  const runLogPath = join(workdir, "run.log");
  writeFileSync(specPath, testCase.spec);

  const env = {
    ...process.env,
    NO_COLOR: "1",
    SER_PLANNER_TIMEOUT_MS: opts.plannerTimeoutMs,
    SER_RUNG_TIMEOUT_MS: opts.rungTimeoutMs,
    SER_DUMP_STAGE_FAIL: stageFailPath,
  };
  const derive = await runLogged([
    opts.bin,
    "dev",
    "derive",
    specPath,
    "--workdir",
    workdir,
    "--out",
    missionPath,
    "--chain",
    opts.chain,
    "--budget",
    String(testCase.budgetUsd),
  ], { cwd: ROOT, env, timeout: opts.caseTimeoutMs, logPath: deriveLogPath });

  let runExit: number | null = null;
  let runStdout = "";
  let runStderr = "";
  if (derive.exitCode === 0 && existsSync(missionPath)) {
    const run = await runLogged([opts.bin, "dev", "run", missionPath, "--chain", opts.chain], {
      cwd: ROOT,
      env,
      timeout: opts.caseTimeoutMs,
      logPath: runLogPath,
    });
    runExit = run.exitCode;
    runStdout = run.stdout;
    runStderr = run.stderr;
  }

  const deriveText = `${derive.stdout}\n${derive.stderr}`;
  const runText = `${runStdout}\n${runStderr}`;
  const tracePath = runText.match(/^trace:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const costUsd = runText.match(/totals:.*\$(\d+(?:\.\d+)?)/)?.[1] ?? "";
  const ok = runExit === 0 && /MISSION COMPLETE/.test(runText);
  return {
    id: testCase.id,
    ok,
    deriveExit: derive.exitCode ?? 1,
    runExit,
    fallback: /fallback planner/.test(deriveText),
    tracePath,
    workdir,
    deriveLog: deriveLogPath,
    runLog: existsSync(runLogPath) ? runLogPath : null,
    stageFail: stageFailPath,
    durationMs: Date.now() - started,
    costUsd,
    note: ok ? summaryLine(runText) : failureNote(derive, deriveText, runText),
  };
}

async function runLogged(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; logPath: string },
): Promise<CommandResult> {
  try {
    const result = await execa(process.execPath, args, {
      cwd: opts.cwd,
      env: opts.env,
      reject: false,
      timeout: opts.timeout,
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    writeFileSync(opts.logPath, `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`);
    return {
      exitCode: result.exitCode ?? 1,
      stdout,
      stderr,
      timedOut: false,
      failed: result.failed ?? false,
    };
  } catch (err: unknown) {
    const e = err as { exitCode?: number; stdout?: string; stderr?: string; timedOut?: boolean; failed?: boolean; shortMessage?: string; message?: string };
    const stdout = e.stdout ?? "";
    const stderr = [e.stderr, e.shortMessage ?? e.message].filter(Boolean).join("\n");
    writeFileSync(opts.logPath, `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`);
    return {
      exitCode: e.exitCode ?? 124,
      stdout,
      stderr,
      timedOut: e.timedOut ?? false,
      failed: e.failed ?? true,
    };
  }
}

function summaryLine(text: string): string {
  return text.split("\n").find((l) => /^totals:/.test(l))?.trim() ?? "completed";
}

function failureNote(derive: CommandResult, deriveText: string, runText: string): string {
  if (derive.timedOut) return "derive timed out";
  const text = runText.trim() ? runText : deriveText;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.slice(-3).join(" | ").slice(0, 240) || "no output";
}

function renderReport(results: CaseResult[]): string {
  const lines = [
    "# SER Live Eval",
    "",
    "| case | result | derive | run | fallback | cost | duration | note | trace |",
    "|---|---:|---:|---:|---:|---:|---:|---|---|",
  ];
  for (const r of results) {
    lines.push(
      `| ${r.id} | ${r.ok ? "pass" : "fail"} | ${r.deriveExit} | ${r.runExit ?? "-"} | ${r.fallback ? "yes" : "no"} | ${r.costUsd || "-"} | ${Math.round(r.durationMs / 1000)}s | ${escapeCell(r.note)} | ${r.tracePath ?? "-"} |`,
    );
  }
  lines.push("", "Artifacts:");
  for (const r of results) {
    lines.push(`- ${r.id}: workdir=${r.workdir} derive=${r.deriveLog} run=${r.runLog ?? "-"} stage=${r.stageFail}`);
  }
  return lines.join("\n");
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function parseFlags(args: string[]): { bool: Set<string>; value: Map<string, string> } {
  const bool = new Set<string>();
  const value = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (["only", "bin", "chain", "planner-timeout-ms", "rung-timeout-ms", "case-timeout-ms"].includes(key)) value.set(key, args[++i] ?? "");
    else bool.add(key);
  }
  return { bool, value };
}

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err: unknown) => {
  process.stderr.write(`live-eval error: ${(err as Error).message}\n`);
  process.exit(1);
});
