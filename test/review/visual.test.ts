import { describe, it, expect } from "vitest";
import { visualReview, type RenderResult } from "../../src/review/visual.js";
import type { LlmClient } from "../../src/llm/types.js";

// A rendered shot with one fake screenshot — enough for visualReview to attempt a judge call.
const shot: RenderResult = {
  ok: true,
  screenshotPath: "/tmp/x.png",
  dataUrl: "data:image/png;base64,AAAA",
  images: [{ kind: "desktop", screenshotPath: "/tmp/x.png", dataUrl: "data:image/png;base64,AAAA" }],
};
const spec = { thesis: "a thing", stories: ["a user sees the thing"] };
const VERDICT = JSON.stringify({ storyChecks: [{ story: "a user sees the thing", satisfied: true, note: "" }] });

/** Scriptable LlmClient: each entry is a response string OR an Error to throw. */
function scripted(seq: Array<string | Error>): { llm: LlmClient; calls: () => number } {
  let i = 0;
  return {
    calls: () => i,
    llm: {
      async complete() {
        const item = seq[Math.min(i, seq.length - 1)];
        i += 1;
        if (item instanceof Error) throw item;
        return { text: item ?? "", inTokens: 1, outTokens: 1 };
      },
    },
  };
}

describe("visualReview — transient-retry (don't false-halt ship on a blip)", () => {
  it("returns the verdict on the first try without retrying", async () => {
    const s = scripted([VERDICT, VERDICT, VERDICT]);
    const v = await visualReview(shot, spec, s.llm, "m");
    expect(v).not.toBeNull();
    expect(s.calls()).toBe(1);
    expect(v!.storyChecks[0]!.satisfied).toBe(true);
  });

  it("retries past a TRANSIENT THROW (network/5xx/timeout) and then succeeds", async () => {
    const s = scripted([new Error("ECONNRESET"), VERDICT]);
    const v = await visualReview(shot, spec, s.llm, "m", 45_000, 3);
    expect(v).not.toBeNull();
    expect(s.calls()).toBe(2);
  });

  it("retries past a MALFORMED JSON response and then succeeds", async () => {
    const s = scripted(["not json at all", VERDICT]);
    const v = await visualReview(shot, spec, s.llm, "m", 45_000, 3);
    expect(v).not.toBeNull();
    expect(s.calls()).toBe(2);
  });

  it("returns null only after a PERSISTENT failure across every attempt", async () => {
    const s = scripted([new Error("down"), new Error("down")]);
    const v = await visualReview(shot, spec, s.llm, "m", 45_000, 2);
    expect(v).toBeNull();
    expect(s.calls()).toBe(2); // exhausted the bounded retries, didn't spin
  });

  it("does not call the model at all when there is no rendered image", async () => {
    const s = scripted([VERDICT]);
    const v = await visualReview({ ok: false, note: "no browser" }, spec, s.llm, "m");
    expect(v).toBeNull();
    expect(s.calls()).toBe(0);
  });
});
