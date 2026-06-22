import { describe, it, expect } from "vitest";
import { specCompleteness, signature, parseFeatures, COMPLETENESS_LENSES } from "../../src/contract/spec-completeness.js";
import { MockLlm } from "../../src/llm/mock.js";

describe("signature — near-phrasings cluster, distinct features don't", () => {
  it("collapses verb synonyms + strips generic nouns", () => {
    expect(signature("copy key to clipboard")).toBe(signature("copy value to clipboard"));
    expect(signature("copy to clipboard")).toBe(signature("copy the api key"));
    expect(signature("reveal masked key")).toBe(signature("show masked value")); // show -> reveal
    expect(signature("delete a credential")).toBe(signature("remove a key")); // remove -> delete
  });
  it("keeps genuinely different features apart", () => {
    expect(signature("copy key")).not.toBe(signature("delete key"));
    expect(signature("reveal masked key")).not.toBe(signature("search for a key"));
  });
});

describe("parseFeatures — tolerant of fences/prose", () => {
  it("extracts the JSON array even with surrounding text", () => {
    expect(parseFeatures('Sure! ["copy key","delete item"] done')).toEqual(["copy key", "delete item"]);
    expect(parseFeatures("```json\n[\"reveal value\"]\n```")).toEqual(["reveal value"]);
    expect(parseFeatures("no array here")).toEqual([]);
  });
});

describe("specCompleteness — cheap-consensus across diverse lenses", () => {
  const arr = (xs: string[]) => ({ text: JSON.stringify(xs) });
  // 6 lenses; copy/reveal/delete are named by most, export/audit are one-off noise.
  const lensReplies = [
    arr(["copy key to clipboard", "reveal masked key", "delete a credential"]),
    arr(["copy value to clipboard", "show masked value", "delete an entry"]),
    arr(["copy to clipboard", "unmask masked secret", "remove a key", "export all keys"]),
    arr(["copy the api key", "delete item"]),
    arr(["reveal masked credential", "delete a key"]),
    arr(["copy key", "audit log", "reveal masked value"]),
  ];

  it("keeps features a majority of lenses independently name, drops one-offs", async () => {
    const llm = new MockLlm(lensReplies);
    const out = await specCompleteness(llm, "qwen/qwen3-coder", { idea: "a credential vault", stated: ["login", "masked dashboard"] });
    const sigs = out.map((o) => signature(o.feature));
    expect(sigs).toContain(signature("copy to clipboard"));
    expect(sigs).toContain(signature("reveal masked value"));
    expect(sigs).toContain(signature("delete an item"));
    // one-off noise filtered out by the quorum
    expect(sigs).not.toContain(signature("export all keys"));
    expect(sigs).not.toContain(signature("audit log"));
    // each survivor cleared quorum (>=3 of 6) and they're sorted most-agreed first
    expect(out.every((o) => o.votes >= 3)).toBe(true);
    expect(out[0]!.votes).toBeGreaterThanOrEqual(out[out.length - 1]!.votes);
    // one cheap call per lens — no premium model anywhere
    expect(llm.calls).toHaveLength(COMPLETENESS_LENSES.length);
  });

  it("a higher quorum is stricter (only unanimous-ish features survive)", async () => {
    const llm = new MockLlm(lensReplies);
    const out = await specCompleteness(llm, "qwen/qwen3-coder", { idea: "a credential vault", quorum: 6 });
    expect(out.length).toBe(0); // nothing was named by ALL 6 lenses in this fixture
  });
});
