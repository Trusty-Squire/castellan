import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { execa } from "execa";
import { makeMatcher } from "../harness/globs.js";
import type { ToolName, ToolPolicy } from "./types.js";

export interface ToolExecResult {
  ok: boolean;
  output: string;
  /** Relative repo path for write/edit. */
  path?: string;
  /** Command string for bash. */
  command?: string;
  /** True if the call was denied by policy (blast radius / denylist) — write did NOT happen. */
  denied: boolean;
  deniedReason?: string;
}

interface WriteArgs {
  path: string;
  content: string;
}
interface EditArgs {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}
interface ReadArgs {
  path: string;
}
interface BashArgs {
  command: string;
}

const BASH_TIMEOUT_MS = 2 * 60 * 1000;
/**
 * Cap on a single tool's output (read contents, bash stdout/stderr) before it
 * enters the agent's message history. A `find /` or `ls /tmp` can dump tens of
 * thousands of tokens that then get re-sent every turn; this bounds it.
 */
const MAX_TOOL_OUTPUT_BYTES = 12_000;

/** Truncate to a byte cap, keeping the head and tail with a middle marker. */
export function clampOutput(s: string, max = MAX_TOOL_OUTPUT_BYTES): string {
  if (Buffer.byteLength(s, "utf8") <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = max - head - 64;
  const buf = Buffer.from(s, "utf8");
  const omitted = buf.length - head - tail;
  return (
    buf.subarray(0, head).toString("utf8") +
    `\n…[${omitted} bytes of output omitted to bound context]…\n` +
    buf.subarray(buf.length - tail).toString("utf8")
  );
}

/**
 * The one place writes happen. Blast-radius and denylist are enforced here,
 * BEFORE any filesystem mutation — never trusted to the engine or the model.
 */
export class ToolExecutor {
  readonly cwd: string;
  private readonly policy: ToolPolicy;
  private readonly inRadius: (p: string) => boolean;
  /** Paths successfully written/edited this attempt. */
  readonly executedWrites: string[] = [];

  constructor(cwd: string, policy: ToolPolicy) {
    this.cwd = resolve(cwd);
    this.policy = policy;
    this.inRadius = makeMatcher(policy.blastRadius);
  }

  async execute(name: ToolName, args: unknown): Promise<ToolExecResult> {
    if (this.policy.denylist?.includes(name)) {
      return { ok: false, denied: true, deniedReason: `tool "${name}" is denied`, output: `tool "${name}" is denied by policy` };
    }
    switch (name) {
      case "read":
        return this.read(args as ReadArgs);
      case "write":
        return this.write(args as WriteArgs);
      case "edit":
        return this.edit(args as EditArgs);
      case "bash":
        return this.bash(args as BashArgs);
      default:
        return { ok: false, denied: false, output: `unknown tool "${name}"` };
    }
  }

  private read(args: ReadArgs): ToolExecResult {
    const located = this.locate(args.path);
    if ("error" in located) return located.error;
    if (!existsSync(located.abs)) {
      return { ok: false, denied: false, path: located.rel, output: `file not found: ${located.rel}` };
    }
    try {
      const contents = readFileSync(located.abs, "utf8");
      return { ok: true, denied: false, path: located.rel, output: clampOutput(contents) };
    } catch (err) {
      return { ok: false, denied: false, path: located.rel, output: `read failed: ${(err as Error).message}` };
    }
  }

  private write(args: WriteArgs): ToolExecResult {
    const located = this.locate(args.path);
    if ("error" in located) return located.error;
    const denial = this.checkRadius(located.rel, "write");
    if (denial) return denial;
    const content = normalizeWriteContent(located.rel, args.content ?? "");
    try {
      mkdirSync(dirname(located.abs), { recursive: true });
      writeFileSync(located.abs, content);
      this.recordWrite(located.rel);
      return { ok: true, denied: false, path: located.rel, output: `wrote ${located.rel} (${content.length} bytes)` };
    } catch (err) {
      return { ok: false, denied: false, path: located.rel, output: `write failed: ${(err as Error).message}` };
    }
  }

  private edit(args: EditArgs): ToolExecResult {
    const located = this.locate(args.path);
    if ("error" in located) return located.error;
    const denial = this.checkRadius(located.rel, "edit");
    if (denial) return denial;
    if (!existsSync(located.abs)) {
      return { ok: false, denied: false, path: located.rel, output: `cannot edit missing file: ${located.rel}` };
    }
    try {
      const before = readFileSync(located.abs, "utf8");
      if (args.oldString !== "" && !before.includes(args.oldString)) {
        return { ok: false, denied: false, path: located.rel, output: `edit failed: oldString not found in ${located.rel}` };
      }
      const after = args.replaceAll
        ? before.split(args.oldString).join(args.newString)
        : before.replace(args.oldString, args.newString);
      writeFileSync(located.abs, after);
      this.recordWrite(located.rel);
      return { ok: true, denied: false, path: located.rel, output: `edited ${located.rel}` };
    } catch (err) {
      return { ok: false, denied: false, path: located.rel, output: `edit failed: ${(err as Error).message}` };
    }
  }

  private async bash(args: BashArgs): Promise<ToolExecResult> {
    const command = args.command ?? "";
    try {
      const result = await execa(command, {
        cwd: this.cwd,
        shell: true,
        reject: false,
        timeout: BASH_TIMEOUT_MS,
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      return {
        ok: result.exitCode === 0 && !result.timedOut,
        denied: false,
        command,
        output: clampOutput(output || `(exit ${result.exitCode ?? "?"})`),
      };
    } catch (err) {
      return { ok: false, denied: false, command, output: `bash failed: ${(err as Error).message}` };
    }
  }

  private recordWrite(rel: string): void {
    if (!this.executedWrites.includes(rel)) this.executedWrites.push(rel);
  }

  private checkRadius(rel: string, name: ToolName): ToolExecResult | null {
    if (this.inRadius(rel)) return null;
    const allowed = this.policy.blastRadius.join(", ") || "none";
    const reason = `path "${rel}" is outside blast_radius (${allowed})`;
    // Directive nudge: the worker's denied writes were scratch/alt-name files (foo_new.js,
    // foo_fixed.json) when its intent mapped to an allowed path. Tell it to revise the REAL
    // file in place rather than spawn a copy, so it stops burning denials on variants.
    const output = `DENIED: ${name} to "${rel}" — not in your writable set. Write ONLY to these exact paths: ${allowed}. To revise a file, write to or edit its real path; do NOT create *_new / *_fixed / scratch copies.`;
    return { ok: false, denied: true, deniedReason: reason, path: rel, output };
  }

  /** Resolve a tool path to an in-repo relative path, rejecting escapes. */
  private locate(p: string): { abs: string; rel: string } | { error: ToolExecResult } {
    const abs = isAbsolute(p) ? resolve(p) : resolve(this.cwd, p);
    const rel = relative(this.cwd, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return {
        error: {
          ok: false,
          denied: true,
          deniedReason: `path "${p}" escapes the workdir`,
          output: `DENIED: path "${p}" escapes the workdir`,
        },
      };
    }
    return { abs, rel: rel.replace(/\\/g, "/") };
  }
}

export function normalizeWriteContent(rel: string, content: string): string {
  if (!/\.(?:c?js|mjs)$/.test(rel)) return content;
  const trimmed = content.trim();
  if (!trimmed) return content;
  if (!looksLikeTopLevelJsLiteral(trimmed)) return content;
  return `module.exports = ${trimmed};\n`;
}

function looksLikeTopLevelJsLiteral(content: string): boolean {
  if (!content.startsWith("[") && !content.startsWith("{")) return false;
  if (/^\{\s*(?:module\.)?exports\b/.test(content)) return false;
  if (/\b(?:module\.)?exports\s*=/.test(content)) return false;
  if (/\b(?:function|const|let|var|class|import|export)\b/.test(content)) return false;
  return true;
}
