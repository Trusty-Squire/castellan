import { describe, it, expect } from "vitest";
import { specCompleteness, parseFeatures, COMPLETENESS_LENSES } from "../../src/contract/spec-completeness.js";
import { MockLlm } from "../../src/llm/mock.js";

describe("parseFeatures — array OR object replies (cheap models return both)", () => {
  it("extracts a JSON array, tolerant of fences/prose", () => {
    expect(parseFeatures('Sure! ["copy link","delete a link"] done')).toEqual(["copy link", "delete a link"]);
    expect(parseFeatures("```json\n[\"reveal value\"]\n```")).toEqual(["reveal value"]);
  });
  it("falls back to a JSON OBJECT's humanized keys (the {feature: description} shape)", () => {
    expect(parseFeatures('{"custom_aliases":"...","clickAnalytics":"..."}')).toEqual(["custom aliases", "click analytics"]);
  });
  it("returns [] on no JSON", () => {
    expect(parseFeatures("no json here")).toEqual([]);
  });
});

describe("specCompleteness — diverse-lens RECALL then one cheap MERGE", () => {
  const arr = (xs: string[]) => ({ text: JSON.stringify(xs) });

  it("recalls per lens, then the merge pass returns the agreed (synonym-collapsed) features", async () => {
    // 6 lens recalls (varied phrasings of the same few capabilities) + 1 merge reply.
    const llm = new MockLlm([
      arr(["copy the short link", "set link expiration", "view click counts"]),
      arr(["copy url to clipboard", "expiry date for links", "click analytics"]),
      arr(["custom alias", "expiration settings", "delete a link"]),
      arr(["custom short code", "track clicks", "qr code"]),
      arr(["copy link", "delete link", "custom alias"]),
      arr(["click stats", "delete a short link", "set expiry"]),
      // the MERGE pass output (synonyms collapsed, ordered by agreement):
      arr(["copy the link", "delete a link", "click analytics", "link expiration", "custom alias"]),
    ]);
    const out = await specCompleteness(llm, "qwen/qwen3-coder", { idea: "a URL shortener", stated: ["shorten a url", "redirect"] });
    expect(out).toEqual(["copy the link", "delete a link", "click analytics", "link expiration", "custom alias"]);
    // 6 lens calls + 1 merge call — all cheap, no premium model
    expect(llm.calls).toHaveLength(COMPLETENESS_LENSES.length + 1);
    // the merge call was given each reviewer's list
    expect(llm.calls[6]!.user).toContain("Reviewer 1:");
    expect(llm.calls[6]!.user).toContain("Reviewer 6:");
  });

  it("returns [] when every lens comes back empty (nothing to merge)", async () => {
    const llm = new MockLlm([arr([]), arr([]), arr([]), arr([]), arr([]), arr([])]);
    expect(await specCompleteness(llm, "qwen/qwen3-coder", { idea: "x" })).toEqual([]);
  });
});
