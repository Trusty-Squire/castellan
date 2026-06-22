import { describe, it, expect } from "vitest";
import { reconcile } from "../../src/harness/reconcile.js";
import type { AttemptRecord } from "../../src/engine/types.js";

function record(partial: Partial<AttemptRecord>): AttemptRecord {
  return {
    toolCalls: [],
    executedWrites: [],
    blastDeniedCount: 0,
    inTokens: 0,
    outTokens: 0,
    finalMessage: "",
    errored: false,
    ...partial,
  };
}

describe("reconcile", () => {
  it("passes when writes are in-diff and in-radius, no confab", () => {
    const r = reconcile({
      blastRadius: ["src/**"],
      doneCheck: "pnpm test",
      changedFiles: ["src/a.ts"],
      record: record({
        executedWrites: ["src/a.ts"],
        finalMessage: "I edited src/a.ts and ran pnpm test which passed.",
        toolCalls: [
          { id: "1", name: "bash", args: {}, ok: true, output: "", command: "pnpm test", denied: false },
        ],
      }),
    });
    expect(r.violations).toEqual([]);
    expect(r.confabulation).toBe(false);
  });

  it("does NOT fail a node for the byproducts of doing the work (the secure-storage rung-2 case)", () => {
    // qwen built correct encryption (the gate passed), but wrote the DB its gate reads +
    // installed a dep — byproducts, never another node's source. Must not be a violation.
    const r = reconcile({
      blastRadius: ["crypto.js", "storage.js", "data/.gitkeep"],
      doneCheck: "node -e require('./storage')",
      changedFiles: ["storage.js", "crypto.js", "data/app.db", "node_modules/.bin/node-gyp", "package-lock.json"],
      record: record({ executedWrites: ["storage.js", "crypto.js"], finalMessage: "encrypted and stored" }),
    });
    expect(r.violations).toEqual([]);
  });

  it("allows standard project plumbing the builder creates to run its own checks", () => {
    const r = reconcile({
      blastRadius: ["src/**"],
      doneCheck: "npm test",
      changedFiles: ["src/parse.ts", "package.json", "tsconfig.json", "vitest.config.ts", "index.html", ".gitignore"],
      record: record({ executedWrites: ["src/parse.ts"], finalMessage: "wrote it and ran npm test", toolCalls: [{ id: "1", name: "bash", args: {}, ok: true, output: "", command: "npm test", denied: false }] }),
    });
    expect(r.outOfRadius).toEqual([]); // plumbing files are not radius violations
    expect(r.violations).toEqual([]);
  });

  it("still flags a genuine out-of-radius source file (not plumbing)", () => {
    const r = reconcile({
      blastRadius: ["src/**"],
      doneCheck: "true",
      changedFiles: ["src/a.ts", "other/b.ts"],
      record: record({ executedWrites: ["src/a.ts", "other/b.ts"] }),
    });
    expect(r.outOfRadius).toEqual(["other/b.ts"]);
    expect(r.violations.some((v) => v.includes("other/b.ts"))).toBe(true);
  });

  it("flags a write that never reached the git diff", () => {
    const r = reconcile({
      blastRadius: ["src/**"],
      doneCheck: "true",
      changedFiles: [],
      record: record({ executedWrites: ["src/a.ts"] }),
    });
    expect(r.missingFromDiff).toEqual(["src/a.ts"]);
    expect(r.violations.length).toBeGreaterThan(0);
  });

  it("flags a change outside blast_radius", () => {
    const r = reconcile({
      blastRadius: ["src/**"],
      doneCheck: "true",
      changedFiles: ["src/a.ts", "secrets/leak.ts"],
      record: record({ executedWrites: ["src/a.ts"] }),
    });
    expect(r.outOfRadius).toEqual(["secrets/leak.ts"]);
    expect(r.violations.some((v) => v.includes("secrets/leak.ts"))).toBe(true);
  });

  it("sets confabulation when a check is claimed but no bash ran one", () => {
    const r = reconcile({
      blastRadius: ["src/**"],
      doneCheck: "pnpm test",
      changedFiles: ["src/a.ts"],
      record: record({
        executedWrites: ["src/a.ts"],
        finalMessage: "All tests pass now.",
        toolCalls: [
          { id: "1", name: "write", args: {}, ok: true, output: "", path: "src/a.ts", denied: false },
        ],
      }),
    });
    expect(r.confabulation).toBe(true);
    // confabulation alone is not a hard violation
    expect(r.violations).toEqual([]);
  });

  it("does not confabulate when the matching done_check command ran", () => {
    const r = reconcile({
      blastRadius: ["src/**"],
      doneCheck: "pnpm vitest run test/x",
      changedFiles: ["src/a.ts"],
      record: record({
        executedWrites: ["src/a.ts"],
        finalMessage: "tests green",
        toolCalls: [
          {
            id: "1",
            name: "bash",
            args: {},
            ok: true,
            output: "",
            command: "pnpm vitest run test/x",
            denied: false,
          },
        ],
      }),
    });
    expect(r.confabulation).toBe(false);
  });
});
