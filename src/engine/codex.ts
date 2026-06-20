import { execa } from "execa";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute, relative } from "node:path";
import { renderPackedFiles } from "../harness/context.js";
import type { AttemptRequest, Engine, EngineEvent, ToolName } from "./types.js";

/**
 * CodexEngine — real agent execution via the Codex CLI (`codex exec`), running
 * on the user's subscription. Unlike PiEngine (which drives a harness-owned
 * tool loop over an OpenRouter model), codex IS the agent: it edits files in the
 * workspace itself under its own sandbox. So blast-radius is NOT enforced per
 * write here — the harness enforces it AFTER the attempt via the git diff
 * (reconcile flags any change outside blast_radius → node fails → git reset).
 * We surface codex's file_change / command items as tool events for the trace,
 * and its token usage for budgeting.
 *
 * Output is buffered then mapped (not streamed): the live TUI progress is driven
 * by the runner's own trace milestones, not engine events, so buffering costs no
 * legibility and is far more robust than parsing a half-written JSONL stream.
 */
export class CodexEngine implements Engine {
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly model?: string;

  constructor(opts: { bin?: string; timeoutMs?: number; model?: string } = {}) {
    this.bin = opts.bin ?? "codex";
    this.timeoutMs = opts.timeoutMs ?? 600_000; // 10m: generous for a real node, fast recovery on a hang
    this.model = opts.model ?? process.env.CODEX_MODEL;
  }

  async *runAttempt(req: AttemptRequest): AsyncIterable<EngineEvent> {
    const dir = mkdtempSync(join(tmpdir(), "codex-eng-"));
    const msgFile = join(dir, "msg.txt");
    const globs = req.tools.blastRadius.length ? req.tools.blastRadius.join(", ") : "(none — do not write files)";
    const prompt = [
      req.systemPrompt,
      "",
      "TASK:",
      req.brief,
      "",
      `You are working directly in ${req.cwd}. Implement the task by creating/editing files in these globs: ${globs} (plus standard project plumbing — package.json, tsconfig, test/build config, the html entry — which you may create as needed).`,
      "WORK ITERATIVELY — DO NOT WRITE BLIND. Implement, then actually RUN it: run the tests, build it, exercise the code, and for a UI render and open it. Read the failures and FIX until it genuinely works. Code you never ran is how bugs ship — running and iterating is exactly your job, not something to skip. Install dependencies and run the project's checks freely.",
      "KEEP THE TREE CLEAN so the harness can verify your work: build/test byproducts (node_modules, dist, caches, coverage, lockfiles) are already gitignored and fine to generate. Do NOT leave stray NON-artifact files (scratch/sample/output/log files) OUTSIDE the allowed globs above — any such stray file FAILS the whole piece. Your deliverables go in those globs.",
      req.files.length > 0 ? `\n=== CONTEXT FILES ===\n${renderPackedFiles(req.files)}` : "",
    ].join("\n");

    const args = [
      "exec",
      "-C", req.cwd,
      // workspace-write contains file writes to the build dir (reconcile enforces
      // blast-radius post-turn anyway), but the builder now RUNS its own checks —
      // so it needs network to install deps and run the tests/build it iterates on.
      "-s", "workspace-write",
      "-c", "sandbox_workspace_write.network_access=true",
      "--skip-git-repo-check",
      "--color", "never",
      "--json",
      "-o", msgFile,
      ...(this.model ? ["-m", this.model] : []),
      prompt,
    ];

    let stdout = "";
    let errored = false;
    let errorMessage = "";
    // `codex exec` spawns sandbox grandchildren that hold the stdout pipe open, so
    // execa's own `timeout` SIGTERMs the codex parent but then awaits a stream the
    // surviving grandchild never closes — the whole build hangs indefinitely (a node
    // stalled 5+ hours in testing). So: run codex DETACHED (its own process group)
    // and race the await against a hard wall-clock. If the wall wins, SIGKILL the
    // ENTIRE group (-pid) to reap the orphaned grandchildren, abandon the await, and
    // fail the turn — the rung ladder then retries/escalates instead of hanging.
    const subprocess = execa(this.bin, args, {
      timeout: this.timeoutMs,
      stdin: "ignore",
      reject: false,
      detached: true,
      forceKillAfterDelay: 10_000,
    });
    subprocess.catch(() => {}); // we may abandon the await on hard-timeout; never an unhandled rejection
    const hardWallMs = this.timeoutMs + 30_000;
    const killGroup = (): void => {
      try {
        if (subprocess.pid) process.kill(-subprocess.pid, "SIGKILL");
      } catch {
        /* group already gone */
      }
      try {
        subprocess.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    };
    try {
      const res = await Promise.race([
        subprocess,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`codex exec hard-timeout after ${Math.round(hardWallMs / 1000)}s — abandoning a hung subprocess`)), hardWallMs).unref(),
        ),
      ]);
      stdout = res.stdout ?? "";
      if (res.exitCode !== 0) {
        errored = true;
        errorMessage = `codex exec exited ${res.exitCode}: ${(res.stderr || res.stdout || "").slice(-400)}`;
      }
    } catch (err) {
      killGroup();
      errored = true;
      errorMessage = (err as Error).message.split("\n")[0] ?? "codex exec failed";
    }

    // Map codex JSONL items → harness EngineEvents.
    let finalText = "";
    let seq = 0;
    for (const ev of parseCodexEvents(stdout, req.cwd)) {
      if (ev.kind === "message") { finalText = ev.text || finalText; continue; }
      if (ev.kind === "usage") { yield { kind: "usage", inTokens: ev.inTokens, outTokens: ev.outTokens }; continue; }
      // file_change / command → tool_call + tool_result pair
      const id = `cx${seq++}`;
      yield { kind: "tool_call", id, name: ev.tool, args: ev.args };
      yield { kind: "tool_result", id, ok: true, output: ev.output };
    }

    // Prefer the clean -o final message; fall back to the last agent_message.
    let lastMsg = finalText;
    try { const f = readFileSync(msgFile, "utf8").trim(); if (f) lastMsg = f; } catch { /* no file on error */ }
    rmSync(dir, { recursive: true, force: true });

    if (errored) yield { kind: "error", message: errorMessage };
    else yield { kind: "done", finalMessage: lastMsg };
  }
}

export type CodexMappedEvent =
  | { kind: "message"; text: string }
  | { kind: "usage"; inTokens: number; outTokens: number }
  | { kind: "tool_change"; tool: ToolName; args: unknown; output: string };

/** Parse codex `--json` JSONL into the subset of events the harness records. Tolerant of noise. */
export function parseCodexEvents(stdout: string, cwd: string): CodexMappedEvent[] {
  const rel = (p: string): string => (isAbsolute(p) ? relative(cwd, p) : p);
  const out: CodexMappedEvent[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(t) as Record<string, unknown>; } catch { continue; }

    if (obj.type === "turn.completed" && obj.usage && typeof obj.usage === "object") {
      const u = obj.usage as Record<string, number>;
      out.push({ kind: "usage", inTokens: Number(u.input_tokens ?? 0), outTokens: Number(u.output_tokens ?? 0) });
      continue;
    }
    if (obj.type !== "item.completed") continue;
    const item = obj.item as Record<string, unknown> | undefined;
    if (!item) continue;

    if (item.type === "agent_message" && typeof item.text === "string") {
      out.push({ kind: "message", text: item.text });
    } else if (item.type === "file_change" && Array.isArray(item.changes)) {
      for (const c of item.changes as { path?: string; kind?: string }[]) {
        const path = rel(String(c.path ?? ""));
        const tool: ToolName = c.kind === "add" ? "write" : "edit";
        out.push({ kind: "tool_change", tool, args: { path }, output: `${c.kind ?? "change"} ${path}` });
      }
    } else if (typeof item.type === "string" && /command|exec/i.test(item.type)) {
      const command = String((item as { command?: string }).command ?? (item as { aggregated_output?: string }).aggregated_output ?? "");
      out.push({ kind: "tool_change", tool: "bash", args: { command }, output: command });
    }
  }
  return out;
}
