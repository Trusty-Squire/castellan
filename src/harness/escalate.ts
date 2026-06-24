import type { Chain } from "../contract/schema.js";

/**
 * Cap the prior-attempt diff attached on rung 4. Unbounded, a multi-file node's full diff
 * (app.js + HTML views + tests) inflates the request past the provider's payload cap — the
 * web-app node 413'd on exactly this. Keep the head (where the substantive changes start) and
 * a tail, with a marker; the knight can re-read any file it needs from the packed context.
 */
const MAX_PRIOR_DIFF_CHARS = 12_000;
export function boundDiff(diff: string, max = MAX_PRIOR_DIFF_CHARS): string {
  if (diff.length <= max) return diff;
  const head = Math.floor(max * 0.7);
  const tail = max - head - 80;
  const omitted = diff.length - head - tail;
  return `${diff.slice(0, head)}\n    …[${omitted} chars of diff omitted to bound the request payload; re-read a file from context if needed]…\n${diff.slice(diff.length - tail)}`;
}

export interface Rung {
  /** 1-based rung number. */
  rung: number;
  /** Model slug to run this rung with. */
  model: string;
  /** Append the structured FAILURE CONTEXT block to the brief. */
  addFailureContext: boolean;
  /** Append the prior attempt's diff (rung 4 only). */
  addPriorDiff: boolean;
  /**
   * REPAIR rung: re-run the SAME model on its OWN failed attempt — do NOT reset to the last
   * green checkpoint first, so the model edits the broken file it just wrote and fixes only what
   * the gate reported (e.g. "ReferenceError: code is not defined at line 54"). A fresh escalation
   * rung resets and rewrites from scratch, discarding a nearly-correct attempt over a one-line
   * slip; a repair rung keeps the work and patches it. This is the cheap×reliable loop: a cheap
   * model that ALMOST passed gets one targeted fix before we spend a pricier model.
   */
  repair?: boolean;
}

/**
 * The escalation ladder (SPEC §9). Each model gets a same-model REPAIR rung (fix your own
 * gate failure in place) before we escalate to the next, pricier model. Exhausting the array =
 * MISSION_HALTED (the runner halts when no rung remains).
 */
export function ladder(chain: Chain): Rung[] {
  return [
    { rung: 1, model: chain.executor, addFailureContext: false, addPriorDiff: false },
    { rung: 2, model: chain.executor, addFailureContext: true, addPriorDiff: false, repair: true },
    { rung: 3, model: chain.fallback, addFailureContext: true, addPriorDiff: false },
    { rung: 4, model: chain.fallback, addFailureContext: true, addPriorDiff: false, repair: true },
    { rung: 5, model: chain.knight, addFailureContext: true, addPriorDiff: false },
    { rung: 6, model: chain.knight, addFailureContext: true, addPriorDiff: true },
  ];
}

export const MAX_RUNGS = 6;

export interface FailureInfo {
  gateCommand: string;
  exitCode: number;
  timedOut: boolean;
  /** The gate's STDOUT tail — for an assertion gate (grep/jq/test/SELECT) the diagnostic
   *  lives HERE, not in stderr: the value that printed is what the check rejected. */
  stdoutTail: string;
  stderrTail: string;
  reconcileViolations: string[];
  confabulation: boolean;
  /** What the previous attempt changed (file list). */
  changedFiles: string[];
  /** Prior attempt's unified diff (only attached on rung 4). */
  priorDiff?: string;
  /** REPAIR rung: the previous attempt's files are STILL in the tree — fix them in place. */
  repair?: boolean;
}

/**
 * Build the FAILURE CONTEXT block — structured, harness-authored, never free
 * prose from the failed model. The failed attempt's transcript is NOT carried
 * forward (SPEC §9).
 */
export function buildFailureContext(info: FailureInfo): string {
  const lines: string[] = [];
  lines.push("=== FAILURE CONTEXT (previous attempt) ===");
  lines.push("The previous attempt did not pass the gate. Facts:");
  lines.push(`- gate command: ${info.gateCommand}`);
  lines.push(`- gate exit code: ${info.exitCode}${info.timedOut ? " (timed out)" : ""}`);
  if (info.stdoutTail.trim()) {
    // The single most useful signal for an assertion gate: WHAT the check saw. A grep/jq/
    // test failure is silent on stderr; the value it rejected is right here on stdout.
    // READ IT to diagnose (e.g. a stored value that is still plaintext when it had to be
    // encrypted, a number that's off, a field that's missing) — don't just retry blindly.
    lines.push("- gate output (stdout tail) — THE DIAGNOSTIC; read it to see exactly what the check rejected:");
    lines.push(indent(info.stdoutTail.trim(), "    "));
  }
  if (info.stderrTail.trim()) {
    lines.push("- gate stderr (tail):");
    lines.push(indent(info.stderrTail.trim(), "    "));
  }
  const loadHint = moduleLoadHint(`${info.stderrTail}\n${info.stdoutTail}`);
  if (loadHint) lines.push(`- ${loadHint}`);
  if (info.reconcileViolations.length > 0) {
    lines.push("- reconcile violations:");
    for (const v of info.reconcileViolations) lines.push(`    * ${v}`);
  }
  if (info.confabulation) {
    lines.push("- WARNING: previous attempt claimed a check ran but no such command was executed.");
  }
  lines.push(
    info.changedFiles.length > 0
      ? `- files the previous attempt changed: ${info.changedFiles.join(", ")}`
      : "- the previous attempt changed no files.",
  );
  if (info.priorDiff && info.priorDiff.trim()) {
    lines.push("- previous attempt diff:");
    lines.push(indent(boundDiff(info.priorDiff.trim()), "    "));
  }
  lines.push(
    info.repair
      ? "YOUR previous attempt's files are STILL IN PLACE (not reset). Read them and FIX ONLY what the gate reported above — edit the offending lines; do NOT rewrite from scratch or re-create files that are already correct."
      : "Start fresh from the current (reset) repository state. Do not assume any prior change persists.",
  );
  lines.push("=== END FAILURE CONTEXT ===");
  return lines.join("\n");
}

/**
 * Distinguish an IMPORT/LOAD-TIME failure from a logic bug. When a gate dies because the module no
 * longer exports what the test imports (the cheap model changed the export shape while editing), the
 * raw stack ("X is not a constructor") reads like a logic error and the model thrashes. Name the
 * root cause so the repair rung fixes the export instead of rewriting the file.
 */
function moduleLoadHint(text: string): string | null {
  if (/\bis not a constructor\b|\bis not a function\b|Cannot find module|ERR_MODULE_NOT_FOUND|is not defined in ES module scope|has no exported member/.test(text)) {
    return 'DIAGNOSIS: this is an IMPORT/LOAD-TIME failure, NOT a logic bug — the module no longer exports what the test imports. You almost certainly changed the export shape while editing (e.g. broke "module.exports = { Sheet }"). RESTORE the exact export the SHARED CONTRACT lists, then re-run; do NOT rewrite the file.';
  }
  return null;
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}
