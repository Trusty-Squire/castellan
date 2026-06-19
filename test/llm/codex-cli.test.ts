import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SquireError } from "../../src/errors.js";
import { writeImageDataUrls } from "../../src/llm/codex-cli.js";

describe("writeImageDataUrls", () => {
  it("materializes data URLs as image files for codex exec --image", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-img-test-"));
    try {
      const path = writeImageDataUrls([{ dataUrl: "data:image/png;base64,aGVsbG8=" }], dir)[0]!;
      expect(path.endsWith(".png")).toBe(true);
      expect(readFileSync(path).toString("utf8")).toBe("hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid data URLs", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-img-test-"));
    try {
      expect(() => writeImageDataUrls([{ dataUrl: "nope" }], dir)).toThrow(SquireError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
