/**
 * A tiny append-only follower for the build's trace JSONL. The child build writes
 * `<buildDir>/.squire/trace-<missionId>.jsonl` synchronously, one complete event per
 * line (src/harness/trace.ts). We poll (not fs.watch — more robust on phone terminals
 * and sandboxed filesystems), parse only complete newline-terminated lines past a saved
 * offset, and hand each validated event to a renderer. Parsing/render errors never kill
 * the follower — a half-written tail is simply retried on the next tick.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TraceEventSchema, type TraceEvent } from "../harness/trace.js";

export interface TraceFollower {
  /** Lock onto an exact trace file (from the child's `trace: <path>` start-print). */
  pin(path: string): void;
  /** The file currently being followed (pinned, else newest by mtime), or null. */
  resolvedPath(): string | null;
  /** Stop polling, then drain any remaining complete lines one last time. */
  stop(): void;
}

/**
 * @param since  Only the newest-fallback honours this: a trace file whose mtime predates
 *   `since` (a PREVIOUS run's leftover trace) is ignored, so we never replay a dead run's
 *   milestones as if they were live. An explicit pin() always wins regardless of `since`.
 */
export function followTrace(squireDir: string, onEvent: (ev: TraceEvent) => void, since = 0): TraceFollower {
  let pinned: string | null = null;
  let active: string | null = null;
  let consumed = 0; // count of lines already emitted from `active`
  let stopped = false;

  const newest = (): string | null => {
    if (!existsSync(squireDir)) return null;
    let best: string | null = null;
    let bestMtime = -1;
    for (const f of readdirSync(squireDir)) {
      if (!/^trace-.*\.jsonl$/.test(f)) continue;
      const p = join(squireDir, f);
      let m = 0;
      try { m = statSync(p).mtimeMs; } catch { continue; }
      if (m < since) continue; // a leftover from an earlier run — don't replay it as live
      if (m > bestMtime) { bestMtime = m; best = p; }
    }
    return best;
  };

  const target = (): string | null => pinned ?? newest();

  const drain = (): void => {
    const t = target();
    if (t && t !== active) { active = t; consumed = 0; } // switched file → restart
    if (!active || !existsSync(active)) return;
    let text: string | null = null;
    try { text = readFileSync(active, "utf8"); } catch { text = null; }
    if (text === null) return; // transient read failure — keep the offset, retry next tick
    const lines = text.split("\n");
    const complete = lines.length - 1; // last chunk is "" (file ends in \n) or a partial line
    for (let i = consumed; i < complete; i++) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      const ev = TraceEventSchema.safeParse(parsed);
      if (ev.success) { try { onEvent(ev.data); } catch { /* a renderer throw must not stop the follow */ } }
    }
    consumed = complete;
  };

  const iv = setInterval(() => { if (!stopped) drain(); }, 400);
  if (iv.unref) iv.unref();

  return {
    pin(path: string): void { if (path && path !== pinned) { pinned = path; active = null; consumed = 0; } },
    resolvedPath(): string | null { return active ?? target(); },
    stop(): void { clearInterval(iv); drain(); stopped = true; },
  };
}
