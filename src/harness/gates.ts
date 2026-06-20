import { execa } from "execa";
import { SquireError } from "../errors.js";
import type { Gate } from "../contract/schema.js";

const TAIL_BYTES = 4096;
export const DEFAULT_GATE_TIMEOUT_MS = 5 * 60 * 1000;

export interface GateResult {
  command: string;
  passed: boolean;
  exitCode: number;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  /** Gate tier that produced this result (SPEC-v0.2 §4). */
  gateType?: Gate["type"];
  /** Soft gates flag instead of failing; passed is forced true when soft. */
  soft?: boolean;
  /** Tier-3 soft-gate flag text (judge verdict or skip note). */
  judgeFlag?: string;
  /** Tier-4 verdict metadata. */
  verdict?: { approved: boolean; reason: string; by: string };
}

/** Tier-4 adjudicator: shown an artifact, returns a verdict. Injectable for tests; CLI provides a prompt. */
export type Adjudicator = (req: {
  nodeId: string;
  artifact: string;
  brief: string;
}) => Promise<{ approved: boolean; reason: string; by: string }>;

export interface GateExecContext {
  cwd: string;
  nodeId: string;
  brief: string;
  timeoutMs?: number;
  adjudicate?: Adjudicator;
}

/**
 * Execute any gate tier (SPEC-v0.2 §4).
 * - command/metric: shell, exit 0 = pass (unchanged v0.1 semantics).
 * - human: pause on the adjudication artifact; the verdict is the gate.
 *   No adjudicator available → typed error (never a silent pass/fail).
 * - judge: SOFT ONLY in v0.2 — never fails the node; emits a flag. With no
 *   judge runner shipped yet, the flag records that the check was skipped.
 */
export async function executeGate(gate: Gate, ctx: GateExecContext): Promise<GateResult> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  switch (gate.type) {
    case "command":
    case "metric": {
      const result = await runGate(gate.run!, ctx.cwd, timeoutMs);
      return { ...result, gateType: gate.type, soft: gate.soft };
    }
    case "human": {
      if (!ctx.adjudicate) {
        throw new SquireError(
          "HUMAN_GATE_UNATTENDED",
          `node "${ctx.nodeId}" has a human gate (artifact: ${gate.artifact}) but no adjudicator is available in this context (unattended run?)`,
        );
      }
      const started = Date.now();
      const verdict = await ctx.adjudicate({
        nodeId: ctx.nodeId,
        artifact: gate.artifact!,
        brief: ctx.brief,
      });
      return {
        command: `human:${gate.artifact}`,
        passed: verdict.approved,
        exitCode: verdict.approved ? 0 : 1,
        timedOut: false,
        stdoutTail: "",
        stderrTail: verdict.approved ? "" : `human reviewer rejected: ${verdict.reason}`,
        durationMs: Date.now() - started,
        gateType: "human",
        soft: false,
        verdict,
      };
    }
    case "judge": {
      // v0.2: no judge runner ships; soft gates never fail — record the skip.
      return {
        command: `judge:${gate.judge?.model ?? "unconfigured"}`,
        passed: true,
        exitCode: 0,
        timedOut: false,
        stdoutTail: "",
        stderrTail: "",
        durationMs: 0,
        gateType: "judge",
        soft: true,
        judgeFlag: `judge gate not executed (v0.2 ships no judge runner); rubric="${gate.judge?.rubric ?? ""}" model=${gate.judge?.model ?? "?"}`,
      };
    }
  }
}

/**
 * Run a done_check as a shell command, judged purely by exit code.
 * No prose evaluation anywhere — exit 0 = pass (SPEC: gates are shell
 * commands judged by exit code).
 */
export async function runGate(
  command: string,
  cwd: string,
  timeoutMs: number = DEFAULT_GATE_TIMEOUT_MS,
): Promise<GateResult> {
  const started = Date.now();
  // The gate runs an arbitrary shell command (npm test → vitest, npm install, …)
  // that can spawn grandchildren which hold the stdout pipe open — a vitest worker
  // with an unclosed handle, a dev server. execa's `timeout` SIGTERMs the `sh -c`
  // parent but then awaits a stream the surviving grandchild never closes, so the
  // gate hangs for HOURS past its timeout (a build stalled 2h on a hung vitest
  // worker). So: run DETACHED (its own process group), race the await against a hard
  // wall, and on the wall SIGKILL the ENTIRE group (-pid) to reap the orphans, then
  // report a timeout failure so the rung ladder retries instead of hanging.
  const subprocess = execa(command, {
    cwd,
    shell: true,
    timeout: timeoutMs,
    reject: false,
    all: false,
    stripFinalNewline: false,
    detached: true,
    forceKillAfterDelay: 10_000,
  });
  subprocess.catch(() => {});
  const killGroup = (): void => {
    try { if (subprocess.pid) process.kill(-subprocess.pid, "SIGKILL"); } catch { /* group gone */ }
    try { subprocess.kill("SIGKILL"); } catch { /* already dead */ }
  };
  const hardWallMs = timeoutMs + 30_000;
  let hardTimedOut = false;
  try {
    const result = await Promise.race([
      subprocess,
      new Promise<never>((_, reject) =>
        setTimeout(() => { hardTimedOut = true; reject(new Error(`gate hard-timeout after ${Math.round(hardWallMs / 1000)}s`)); }, hardWallMs).unref(),
      ),
    ]);
    return {
      command,
      passed: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode ?? 1,
      timedOut: Boolean(result.timedOut),
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    // A hung gate (hard-wall) or a spawn failure (command not found). Kill the whole
    // group to reap any pipe-holding orphans, then fail the gate.
    killGroup();
    const e = err as { shortMessage?: string; message?: string };
    return {
      command,
      passed: false,
      exitCode: hardTimedOut ? 124 : 127,
      timedOut: hardTimedOut,
      stdoutTail: "",
      stderrTail: tail(hardTimedOut ? `gate exceeded ${Math.round(hardWallMs / 1000)}s and was killed (likely a test left a process/handle open)` : (e.shortMessage ?? e.message ?? String(err))),
      durationMs: Date.now() - started,
    };
  }
}

/** Keep only the last TAIL_BYTES of output (utf8), prefixing a marker if truncated. */
function tail(value: string | undefined): string {
  const s = value ?? "";
  if (Buffer.byteLength(s, "utf8") <= TAIL_BYTES) return s;
  const buf = Buffer.from(s, "utf8");
  const sliced = buf.subarray(buf.length - TAIL_BYTES).toString("utf8");
  return `…[truncated]\n${sliced}`;
}
