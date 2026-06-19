import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import fg from "fast-glob";

const PACK_IGNORE = [
  "**/.git/**",
  "**/.squire/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/test-results/**",
  "**/playwright-report/**",
];

export interface PackedFile {
  path: string;
  contents: string;
}

export interface PackResult {
  files: PackedFile[];
  truncated: boolean;
  droppedFiles: string[];
  estTokens: number;
}

/**
 * Deterministic token estimate (chars / 4). No tokenizer dependency,
 * offline, stable across runs. Recorded as an estimate in trace.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Assemble a node's packed files from context_globs, relative to workdir.
 * SPEC §5.2: "newest-file-first on overflow" — we sort newest-first by
 * mtime and fill the token budget, so the freshest context survives.
 * Files that don't fit are dropped and recorded for the trace.
 */
export function packContext(opts: {
  workdir: string;
  globs: string[];
  maxTokens: number;
}): PackResult {
  const { workdir, globs, maxTokens } = opts;
  if (globs.length === 0) {
    return { files: [], truncated: false, droppedFiles: [], estTokens: 0 };
  }

  const matches = fg.sync(globs, {
    cwd: workdir,
    dot: false,
    onlyFiles: true,
    absolute: false,
    followSymbolicLinks: false,
    unique: true,
    ignore: PACK_IGNORE,
  });

  // Sort newest-first by mtime so the freshest context survives truncation.
  const withMeta = matches
    .map((rel) => {
      const abs = isAbsolute(rel) ? rel : join(workdir, rel);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(abs).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      return { rel: normalizeRel(workdir, rel), abs, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.rel.localeCompare(b.rel));

  const files: PackedFile[] = [];
  const dropped: string[] = [];
  let estTokens = 0;
  let truncated = false;

  for (const m of withMeta) {
    let contents: string;
    try {
      contents = readFileSync(m.abs, "utf8");
    } catch {
      continue; // unreadable / binary-ish — skip silently
    }
    const cost = estimateTokens(contents) + estimateTokens(m.rel) + 8;
    if (estTokens + cost > maxTokens && files.length > 0) {
      truncated = true;
      dropped.push(m.rel);
      continue;
    }
    files.push({ path: m.rel, contents });
    estTokens += cost;
  }

  // Present files in stable path order for reproducible context blocks.
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, truncated, droppedFiles: dropped.sort(), estTokens };
}

/** Render packed files into the text block appended to a node's context. */
export function renderPackedFiles(files: PackedFile[]): string {
  if (files.length === 0) return "(no files provided)";
  return files
    .map((f) => `=== FILE: ${f.path} ===\n${f.contents.replace(/\s+$/, "")}\n`)
    .join("\n");
}

function normalizeRel(workdir: string, rel: string): string {
  if (!isAbsolute(rel)) return rel;
  return relative(workdir, rel);
}
