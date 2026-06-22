import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PALETTE_THEME_CSS, paletteNote, vendorPalette } from "../../src/contract/palette-scaffold.js";

describe("PALETTE_THEME_CSS", () => {
  it("is a self-contained design system with the core tokens", () => {
    for (const v of ["--bg", "--accent", "--text", "--radius"]) expect(PALETTE_THEME_CSS).toContain(v);
    expect(PALETTE_THEME_CSS).toContain(".btn-primary");
    expect(PALETTE_THEME_CSS).toContain(".card");
  });
});

describe("paletteNote", () => {
  it("tells the node to link + use theme.css, build static, not rewrite it", () => {
    const n = paletteNote();
    expect(n).toContain("public/theme.css");
    expect(n).toContain("STATIC");
    expect(n).toContain("Do NOT rewrite theme.css");
  });
});

describe("vendorPalette — greenfield only", () => {
  it("seeds public/theme.css into an empty workdir", () => {
    const dir = mkdtempSync(join(tmpdir(), "palette-"));
    expect(vendorPalette(dir)).toBe(true);
    expect(existsSync(join(dir, "public", "theme.css"))).toBe(true);
    expect(readFileSync(join(dir, "public", "theme.css"), "utf8")).toContain("--accent");
  });
  it("is a NO-OP when theme.css already exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "palette-"));
    mkdirSync(join(dir, "public"), { recursive: true });
    writeFileSync(join(dir, "public", "theme.css"), "/* mine */\n");
    expect(vendorPalette(dir)).toBe(false);
    expect(readFileSync(join(dir, "public", "theme.css"), "utf8")).toContain("/* mine */");
  });
});
