import { makeMatcher } from "./globs.js";
import type { AttemptRecord } from "../engine/types.js";

export interface ReconcileResult {
  /** Hard reconcile violations (deterministic, no LLM). Non-empty = reconcile failed. */
  violations: string[];
  /** Writes the engine claims it executed but that do not appear in the git diff. */
  missingFromDiff: string[];
  /** Files changed in the tree that fall outside blast_radius. */
  outOfRadius: string[];
  /** Confabulation: claimed a check ran with no matching bash call. Counted, never fails the node. */
  confabulation: boolean;
}

/** Phrases in a final message that claim a check/test/build was run. */
const CLAIM_RE =
  /\b(test|tests|vitest|jest|lint|eslint|typecheck|tsc|build|compiled?|suite|passing|passes|green|exit 0|exited 0)\b/i;

/** A bash command that looks like it runs a check. */
const CHECK_CMD_RE =
  /\b(test|vitest|jest|lint|eslint|tsc|typecheck|build|pnpm|npm|yarn|node|make|cargo|go test|pytest)\b/i;

/**
 * RECONCILING: deterministic checks, no LLM (SPEC §5.5).
 *  - every write/edit the engine executed appears in `git diff`
 *  - no diff outside blast_radius
 *  - confabulation flag if the final message claims a check ran but no
 *    matching bash tool call exists (counted, never fails the node)
 */
export function reconcile(opts: {
  blastRadius: string[];
  doneCheck: string;
  changedFiles: string[];
  record: AttemptRecord;
}): ReconcileResult {
  const { blastRadius, doneCheck, changedFiles, record } = opts;
  const inRadius = makeMatcher(blastRadius);
  const violations: string[] = [];

  // 1. Every executed write must appear in the working-tree diff.
  const changedSet = new Set(changedFiles.map(norm));
  const missingFromDiff = unique(record.executedWrites.map(norm)).filter(
    (p) => !changedSet.has(p),
  );
  for (const p of missingFromDiff) {
    violations.push(`engine wrote "${p}" but it does not appear in git diff`);
  }

  // 2. No change outside blast_radius — EXCEPT standard project plumbing. Once the
  // builder is allowed to run its own checks (write → run → see failure → fix), it
  // must be able to create the project scaffold (manifest, tsconfig, test/build
  // config, the html entry) to run anything at all. These are shared infrastructure,
  // not another node's work, so they're never a blast-radius violation. Pure
  // byproducts (node_modules, dist, caches) are handled by .gitignore upstream.
  const outOfRadius = changedFiles.map(norm).filter((p) => !inRadius(p) && !isPlumbing(p) && !isByproduct(p));
  for (const p of outOfRadius) {
    violations.push(`changed file "${p}" is outside blast_radius`);
  }

  // 3. Confabulation: claimed a check, but no bash call ran one.
  const claimedCheck = CLAIM_RE.test(record.finalMessage);
  const ranCheck = record.toolCalls.some(
    (tc) =>
      tc.name === "bash" &&
      !tc.denied &&
      typeof tc.command === "string" &&
      (commandMatchesDoneCheck(tc.command, doneCheck) || CHECK_CMD_RE.test(tc.command)),
  );
  const confabulation = claimedCheck && !ranCheck;

  return { violations, missingFromDiff, outOfRadius, confabulation };
}

function commandMatchesDoneCheck(command: string, doneCheck: string): boolean {
  const a = command.trim();
  const b = doneCheck.trim();
  return a === b || a.includes(b) || b.includes(a);
}

/** Standard project plumbing the builder may create to run its own checks — shared
 *  infrastructure, never another node's work, so allowed regardless of blast_radius. */
const PLUMBING_RE =
  /^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig(\.[\w-]+)?\.json|(vitest|vite|jest|playwright|eslint|tailwind|postcss)\.config\.[\w]+|\.gitignore|index\.html|pyproject\.toml|setup\.(py|cfg)|requirements\.txt|go\.(mod|sum)|Cargo\.toml)$/;
function isPlumbing(p: string): boolean {
  return PLUMBING_RE.test(p);
}

/**
 * Pure BYPRODUCTS of doing the work — dependency installs, build output, caches, and runtime
 * data/DB/log files. These are residue, never another node's source, so a node must never FAIL
 * its reconcile for producing them (the worker built the part correctly; punishing it for the
 * `data/app.db` its own gate writes, or the `node_modules/` its `npm install` created, is the
 * line failing a good worker for sawdust). Mirrors .gitignore but enforced HERE too, since
 * changedFiles don't always respect it.
 */
const BYPRODUCT_DIR_RE =
  /(^|\/)(node_modules|dist|build|out|coverage|\.next|\.nuxt|\.cache|\.turbo|\.vite|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|venv|target|\.git|data|tmp|\.tmp)\//;
// Runtime stores (a JSON/db file the app or gate writes), editor/backup residue (.bak/.tmp/.orig/.swp),
// and the usual caches/logs — never another node's source, so never a reconcile failure.
const BYPRODUCT_FILE_RE = /\.(db|sqlite|sqlite3|db-journal|log|pyc|pyo|tsbuildinfo|bak|tmp|orig|swp|swo)$|(^|\/)\.DS_Store$|(^|\/)[\w.-]+\.egg-info(\/|$)|(^|\/)data\/[\w.-]+\.json$|(^|\/)(output|out|stdout|stderr|debug|scratch|tmp|temp|test-?out(put)?)\.(txt|out|json|log)$|(^|\/)nohup\.out$/;
function isByproduct(p: string): boolean {
  return BYPRODUCT_DIR_RE.test(p) || BYPRODUCT_FILE_RE.test(p);
}

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}
