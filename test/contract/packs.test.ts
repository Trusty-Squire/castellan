import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDoMission, buildFixMission } from "../../src/contract/packs.js";
import { effectiveGate } from "../../src/contract/schema.js";
import { SquireError } from "../../src/errors.js";

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "packs-"));
  writeFileSync(join(workdir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
});

describe("ser do (one-node mission, zero YAML)", () => {
  it("infers the gate mechanically from the repo's check commands", () => {
    const m = buildDoMission("extract the parser into its own module", workdir);
    expect(m.nodes).toHaveLength(1);
    expect(effectiveGate(m.nodes[0]!).run).toBe("npm run test");
  });

  it("explicit --gate and --radius win", () => {
    const m = buildDoMission("x", workdir, { gate: "make check", radius: ["src/parser/**"] });
    expect(effectiveGate(m.nodes[0]!).run).toBe("make check");
    expect(m.nodes[0]!.blast_radius).toEqual(["src/parser/**"]);
  });

  it("refuses when no gate is detectable (never an ungated node)", () => {
    const bare = mkdtempSync(join(tmpdir(), "packs-bare-"));
    expect(() => buildDoMission("x", bare)).toThrow(SquireError);
    expect(() => buildDoMission("x", bare)).toThrow(/--gate/);
  });
});

describe("ser fix (repro-then-fix pack)", () => {
  it("node 1 demands an assertion-failure repro, rejecting fixture crashes", () => {
    const m = buildFixMission("dates off by one across DST", workdir);
    expect(m.nodes.map((n) => n.id)).toEqual(["repro", "fix"]);
    const repro = effectiveGate(m.nodes[0]!);
    expect(repro.run).toContain("! npm run test test/repro.test.ts");
    expect(repro.run).toContain("AssertionError|expected|FAIL");
    expect(repro.run).toContain("! grep -qE 'ENOENT'");
    // repro writes only tests
    expect(m.nodes[0]!.blast_radius).toEqual(["test/**"]);
  });

  it("node 2 diff-guards the repro and runs the full suite", () => {
    const m = buildFixMission("bug", workdir, { testFile: "test/dst.test.ts" });
    const fix = effectiveGate(m.nodes[1]!);
    expect(fix.run).toBe("npm run test && git diff --quiet HEAD -- test/dst.test.ts");
    expect(m.nodes[1]!.deps).toEqual(["repro"]);
    expect(m.nodes[1]!.blast_radius).toEqual(["src/**"]);
  });
});
