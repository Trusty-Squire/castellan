import { describe, expect, it } from "vitest";
import { formatStageDiagnostic, normalizeStageOutput } from "../../src/contract/derive-normalize.js";

describe("derive stage normalization", () => {
  it("salvages decompose list and numeric fields without changing semantics", () => {
    const normalized = normalizeStageOutput("decompose", {
      nodes: {
        id: "server",
        brief: "build server",
        deps: "base, auth",
        context_globs: "",
        blast_radius: "server.js, package.json, data/notes.json",
        budget_usd: "0.8",
        requirement: "R1",
      },
    }) as { nodes: { deps: string[]; context_globs: string[]; blast_radius: string[]; budget_usd: number }[] };

    expect(normalized.nodes).toHaveLength(1);
    expect(normalized.nodes[0]!.deps).toEqual(["base", "auth"]);
    expect(normalized.nodes[0]!.context_globs).toEqual([]);
    expect(normalized.nodes[0]!.blast_radius).toEqual(["server.js", "package.json", "data/notes.json"]);
    expect(normalized.nodes[0]!.budget_usd).toBe(0.8);
  });

  it("formats failed-stage diagnostics with raw and normalized payloads", () => {
    const text = formatStageDiagnostic({
      stage: "decompose",
      rawText: "{\"nodes\":[]}",
      parsed: { nodes: [] },
      normalized: { nodes: [] },
      validationIssues: [{ code: "too_small", minimum: 1, inclusive: true, type: "array", path: ["nodes"], message: "too small" }],
    });

    expect(text).toContain('"stage": "decompose"');
    expect(text).toContain('"rawText": "{\\"nodes\\":[]}"');
    expect(text).toContain('"normalized"');
    expect(text).toContain('"validationIssues"');
  });
});
