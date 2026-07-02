import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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
 * Broad process-killers (`pkill`, `killall`) match processes by name/pattern and so escape this
 * build's scope: a `pkill -f node` to free a port kills the ser HARNESS running the build (and the
 * MCP servers, and any other node process) — observed mid-run, it killed the supervisor itself.
 * A build never needs to mass-kill processes; block them at the membrane and tell the model the
 * scoped alternative (kill the one PID it started, or just use the harness-assigned $PORT).
 */
export function broadProcessKill(command: string): string | null {
  if (/(^|[;&|(]|\s)(pkill|killall)\b/.test(command)) {
    return (
      "blocked: `pkill`/`killall` match processes by name/pattern and would kill the build harness " +
      "itself (a `pkill -f node` killed ser in a prior run). Do NOT mass-kill processes. To stop a " +
      "server YOU started, capture its PID and kill only that one (`node server.js & SRV=$!; ...; " +
      "kill $SRV`), or just (re)start on the port the harness assigned via $PORT — the harness/gate " +
      "owns server lifecycle and port allocation, so you usually do not need to kill anything."
    );
  }
  return null;
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
    // Poka-yoke: a malformed package.json is a SILENT gate-poisoner — Node parses it during
    // every `require()` resolution, so one bad manifest makes every gate fail with a cryptic
    // ERR_INVALID_PACKAGE_CONFIG and the model thrashes "fixing" the wrong file. Catch it at the
    // point of the mistake with a clear nudge, and don't persist the broken manifest.
    const manifestError = manifestJsonError(located.rel, content);
    if (manifestError) {
      return { ok: false, denied: false, path: located.rel, output: manifestError };
    }
    try {
      mkdirSync(dirname(located.abs), { recursive: true });
      const literalError = executableJsLiteralError(located.rel, content);
      if (literalError) return { ok: false, denied: false, path: located.rel, output: literalError };
      const syntaxError = executableJsSyntaxError(located.rel, content);
      if (syntaxError) return { ok: false, denied: false, path: located.rel, output: syntaxError };
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
    const killBlock = broadProcessKill(command);
    if (killBlock) {
      return { ok: false, denied: true, deniedReason: "broad process-kill blocked", command, output: killBlock };
    }
    try {
      const result = await execa(command, {
        cwd: this.cwd,
        shell: true,
        reject: false,
        timeout: BASH_TIMEOUT_MS,
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      const failed = result.exitCode !== 0 || result.timedOut;
      const status = result.timedOut ? "(timed out)" : `(exit ${result.exitCode ?? "?"})`;
      return {
        ok: !failed,
        denied: false,
        command,
        output: clampOutput(failed ? [output, status].filter(Boolean).join("\n") : output || status),
      };
    } catch (err) {
      return { ok: false, denied: false, command, output: `bash failed: ${(err as Error).message}` };
    }
  }

  private recordWrite(rel: string): void {
    if (!this.executedWrites.includes(rel)) this.executedWrites.push(rel);
  }

  private checkRadius(rel: string, name: ToolName): ToolExecResult | null {
    // Protected paths win over blast_radius: the held-out tests/gate that VERIFY this node are its
    // source of truth — the build must never edit its own grader to "pass". Hard-deny regardless.
    if (this.policy.protectedPaths?.some((p) => norm(p) === norm(rel))) {
      const reason = `path "${rel}" is a held-out gate/test file — protected from writes`;
      return {
        ok: false,
        denied: true,
        deniedReason: reason,
        path: rel,
        output: `DENIED: ${name} to "${rel}" — that is the HELD-OUT TEST that verifies this node; you cannot edit your own grader. Make the implementation satisfy it instead.`,
      };
    }
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

/**
 * If `rel` is a strict-JSON manifest (package.json / package-lock.json) and `content` isn't
 * valid JSON, return a corrective message; else null. Node chokes on a malformed package.json
 * during module resolution, so this must be strict JSON — no comments, no trailing commas.
 */
export function manifestJsonError(rel: string, content: string): string | null {
  const base = rel.split("/").pop();
  if (base !== "package.json" && base !== "package-lock.json") return null;
  try {
    JSON.parse(content);
    return null;
  } catch (err) {
    return `REFUSED to write ${rel}: it is not valid JSON (${(err as Error).message}). ${base} must be STRICT JSON — no comments, no trailing commas, no JS. Node parses it on every require(), so a malformed manifest breaks every check. Re-emit the full file as valid JSON.`;
  }
}

/** Normalize a relative path for comparison: forward slashes, no leading "./". */
function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function normalizeWriteContent(rel: string, content: string): string {
  if (!/\.(?:c?js|mjs)$/.test(rel)) return content;
  const trimmed = content.trim();
  if (!trimmed) return content;
  if (!looksLikeTopLevelJsLiteral(trimmed)) return content;
  if (!isDataModulePath(rel)) return content;
  return `module.exports = ${trimmed};\n`;
}

export function executableJsLiteralError(rel: string, content: string): string | null {
  if (!/\.(?:c?js|mjs)$/.test(rel) || isDataModulePath(rel)) return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith("[") && !looksLikeTopLevelJsLiteral(trimmed)) return null;
  return `REFUSED to write ${rel}: this looks like a top-level data literal, not executable JavaScript source. Re-emit the complete file as raw JS text with imports/requires, functions, control flow, and module.exports/export syntax as needed; do not encode code as arrays, objects, maps, or fragments.`;
}

export function executableJsSyntaxError(rel: string, content: string): string | null {
  if (!/\.(?:c?js|mjs)$/.test(rel) || isDataModulePath(rel)) return null;
  const dir = mkdtempSync(joinTmp("ser-js-check-"));
  const path = `${dir}/check.${rel.endsWith(".mjs") ? "mjs" : "cjs"}`;
  try {
    writeFileSync(path, content);
    const r = spawnSync(process.execPath, ["--check", path], { encoding: "utf8", timeout: 10_000 });
    if (r.status === 0) return null;
    const msg = (r.stderr || r.stdout || "syntax check failed").split("\n").filter(Boolean).slice(0, 8).join("\n");
    return `REFUSED to write ${rel}: JavaScript syntax check failed.\n${msg}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function looksLikeTopLevelJsLiteral(content: string): boolean {
  if (!content.startsWith("[") && !content.startsWith("{")) return false;
  if (/^\{\s*(?:module\.)?exports\b/.test(content)) return false;
  if (/\b(?:module\.)?exports\s*=/.test(content)) return false;
  if (/\b(?:function|const|let|var|class|import|export)\b/.test(content)) return false;
  return true;
}

function isDataModulePath(rel: string): boolean {
  return /(^|\/)(data|fixture|fixtures|mock|mocks|seed|seeds|sample|samples|config|constants|schema|catalog|items)\.(?:c?js|mjs)$/i.test(rel);
}

function joinTmp(prefix: string): string {
  return `${tmpdir().replace(/\/$/, "")}/${prefix}`;
}
