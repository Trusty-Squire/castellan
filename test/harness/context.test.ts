import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packContext, estimateTokens, renderPackedFiles } from "../../src/harness/context.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "squire-ctx-"));
  mkdirSync(join(dir, "src"), { recursive: true });
});

describe("packContext", () => {
  it("packs files matching globs, relative paths", () => {
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(dir, "src", "b.ts"), "export const b = 2;");
    writeFileSync(join(dir, "ignore.md"), "nope");
    const r = packContext({ workdir: dir, globs: ["src/**/*.ts"], maxTokens: 40_000 });
    expect(r.files.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r.truncated).toBe(false);
  });

  it("returns empty when no globs", () => {
    const r = packContext({ workdir: dir, globs: [], maxTokens: 1000 });
    expect(r.files).toEqual([]);
    expect(r.estTokens).toBe(0);
  });

  it("truncates to the token budget keeping newest files, recording drops", () => {
    const big = "x".repeat(4000); // ~1000 tokens each
    writeFileSync(join(dir, "src", "old.ts"), big);
    writeFileSync(join(dir, "src", "new.ts"), big);
    // make old.ts older
    const past = Date.now() / 1000 - 10_000;
    utimesSync(join(dir, "src", "old.ts"), past, past);
    const r = packContext({ workdir: dir, globs: ["src/**/*.ts"], maxTokens: 1100 });
    expect(r.truncated).toBe(true);
    expect(r.files.map((f) => f.path)).toEqual(["src/new.ts"]);
    expect(r.droppedFiles).toEqual(["src/old.ts"]);
  });

  it("ignores generated junk like node_modules and dist even when globs are broad", () => {
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x", "index.js"), "ignored");
    writeFileSync(join(dir, "dist", "bundle.js"), "ignored");
    writeFileSync(join(dir, "src", "kept.ts"), "export const kept = true;");
    const r = packContext({ workdir: dir, globs: ["**/*"], maxTokens: 40_000 });
    expect(r.files.map((f) => f.path)).toEqual(["src/kept.ts"]);
  });

  it("estimateTokens is chars/4 rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("renders a stable file block", () => {
    const block = renderPackedFiles([{ path: "x.ts", contents: "hi\n\n" }]);
    expect(block).toContain("=== FILE: x.ts ===");
    expect(block).toContain("hi");
  });
});
