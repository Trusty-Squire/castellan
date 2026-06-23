import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";

/**
 * Git operations for the node lifecycle. Node pass = commit; node fail =
 * reset --hard to the last green checkpoint BEFORE the next attempt
 * (SPEC §5, architecture invariants).
 *
 * All commands use execa argument arrays — never string-concatenated.
 */

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execa("git", args, { cwd, reject: true });
  return result.stdout.trim();
}

/** Current HEAD commit sha. */
export async function head(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** Initialize a fresh repo with an initial commit of whatever is present. */
export async function initRepo(
  cwd: string,
  opts: { name?: string; email?: string } = {},
): Promise<string> {
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.email", opts.email ?? "squire@cheekysquire.dev"]);
  await git(cwd, ["config", "user.name", opts.name ?? "Cheeky Squire"]);
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", "chore: fixture baseline", "--allow-empty"]);
  return head(cwd);
}

/** Stage everything and commit a node pass. Returns the new sha. */
export async function commitNode(cwd: string, nodeId: string): Promise<string> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", `node(${nodeId}): pass`, "--allow-empty"]);
  return head(cwd);
}

/** Stage everything and commit an arbitrary harness checkpoint. */
export async function commitAll(cwd: string, message: string): Promise<string> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", message, "--allow-empty"]);
  return head(cwd);
}

/**
 * Reset hard to a known-green sha and drop untracked files/dirs from the
 * failed attempt, so the next rung starts from a clean checkpoint.
 */
export async function resetTo(cwd: string, sha: string): Promise<void> {
  await git(cwd, ["reset", "--hard", "-q", sha]);
  await git(cwd, ["clean", "-fdq"]);
}

/** Files changed in the working tree relative to a sha (staged + unstaged + untracked). */
export async function changedFilesSince(cwd: string, sha: string): Promise<string[]> {
  // `-c core.fileMode=false`: ignore executable-bit-only changes. The gate harness `chmod +x`es a
  // node's *.sh check scripts before running them; on a REPAIR rung (which keeps the working tree
  // rather than resetting) that mode flip would otherwise surface as a phantom "changed file outside
  // blast_radius" for a script the model never wrote. A mode change is not a model content edit.
  const tracked = await git(cwd, ["-c", "core.fileMode=false", "diff", "--name-only", sha]);
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  const set = new Set<string>();
  for (const f of [...tracked.split("\n"), ...untracked.split("\n")]) {
    const trimmed = f.trim();
    if (trimmed) set.add(trimmed);
  }
  return [...set].sort();
}

/** Files currently dirty in the working tree (porcelain, path only). */
export async function dirtyFiles(cwd: string): Promise<string[]> {
  // NUL-separated porcelain so the positional XY-status prefix is unambiguous
  // and paths with spaces/specials survive untouched.
  const result = await execa("git", ["status", "--porcelain", "-z"], { cwd, reject: true });
  const files: string[] = [];
  for (const entry of result.stdout.split("\0")) {
    if (!entry) continue;
    // "XY <path>" — status is exactly 2 chars then a separator space.
    const path = entry.slice(3);
    if (path) files.push(path);
  }
  return files.sort();
}

/** Tracked files in the repo (for the raw-mode repo listing). */
export async function listFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ["ls-files"]);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/**
 * True if `dir` is content that an ENCLOSING git repo tracks — i.e. it sits inside a parent repo
 * AND that repo does not gitignore it. Such a dir is real source we must NOT build in place (the
 * per-node commit/reset would mutate the parent's working tree); the caller sandboxes it instead.
 * A dir that is its own repo, is gitignored by its parent (a dedicated build dir under projects/),
 * or lives outside any repo, returns false → safe to git-init and build in place.
 */
export async function trackedByParentRepo(dir: string): Promise<boolean> {
  const top = await execa("git", ["-C", dir, "rev-parse", "--show-toplevel"], { reject: false });
  if (top.exitCode !== 0) return false; // not inside any git repo
  // If `dir` is the repo root itself, an own-repo check (caller's isRepo) governs — not "parent".
  const ignored = await execa("git", ["-C", dir, "check-ignore", "-q", "."], { reject: false });
  return ignored.exitCode !== 0; // exit 0 = ignored by the parent → NOT tracked
}

/** True if the working tree has no changes. */
export async function isClean(cwd: string): Promise<boolean> {
  const result = await execa("git", ["status", "--porcelain"], { cwd, reject: true });
  return result.stdout === "";
}

/**
 * Unified diff of the working tree (including new files via intent-to-add)
 * against a sha. Used to attach the prior attempt's diff on rung 4. The
 * intent-to-add marks are cleared by the next resetTo.
 */
export async function diffSince(cwd: string, sha: string): Promise<string> {
  await git(cwd, ["add", "-A", "-N"]);
  const result = await execa("git", ["diff", sha], { cwd, reject: false });
  return result.stdout;
}

/**
 * Append ignore patterns to .git/info/exclude so the harness's own artifacts
 * (e.g. .squire/) are never staged by `git add -A` nor removed by `git clean`.
 */
export function addGitExclude(cwd: string, patterns: string[]): void {
  const excludeFile = join(cwd, ".git", "info", "exclude");
  const existing = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
  const lines = new Set(existing.split("\n"));
  const toAdd = patterns.filter((p) => !lines.has(p));
  if (toAdd.length === 0) return;
  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
  appendFileSync(excludeFile, prefix + toAdd.join("\n") + "\n");
}
