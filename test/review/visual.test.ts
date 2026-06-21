import { describe, it, expect } from "vitest";
import {
  visualReview,
  freezeDefects,
  unresolvedDefects,
  reviewClosure,
  type RenderResult,
  type FrozenDefect,
} from "../../src/review/visual.js";
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

describe("defect closure — adversarial, abstaining, frozen list (the never-converges fix)", () => {
  const frozen: FrozenDefect[] = [
    { id: "d1", note: "weekly chart is empty", fix: "plot real bars" },
    { id: "d2", note: "headline value not shown", fix: "show the value" },
  ];

  it("freezeDefects ids the exact fixes that blocked (no re-derivation drift)", () => {
    const f = freezeDefects([
      { note: "a", fix: "fix a" },
      { note: "b", fix: "fix b" },
    ]);
    expect(f).toEqual([
      { id: "d1", note: "a", fix: "fix a" },
      { id: "d2", note: "b", fix: "fix b" },
    ]);
    expect(freezeDefects([])).toEqual([]);
  });

  it("unresolvedDefects: only status==='fixed' clears a defect; present AND unsure stay open", () => {
    const closure = [
      { id: "d1", status: "fixed" as const, evidence: "bars visible" },
      { id: "d2", status: "unsure" as const, evidence: "can't tell" },
    ];
    const open = unresolvedDefects(frozen, closure);
    expect(open.map((d) => d.id)).toEqual(["d2"]); // unsure is NOT a pass
  });

  it("unresolvedDefects: a null closure (verifier couldn't run) leaves EVERYTHING open", () => {
    expect(unresolvedDefects(frozen, null).map((d) => d.id)).toEqual(["d1", "d2"]);
  });

  it("unresolvedDefects: a defect the judge OMITTED stays open (no silent pass)", () => {
    const closure = [{ id: "d1", status: "fixed" as const, evidence: "ok" }];
    expect(unresolvedDefects(frozen, closure).map((d) => d.id)).toEqual(["d2"]);
  });

  it("reviewClosure parses per-defect verdicts and normalizes synonyms (resolved→fixed, open→present)", async () => {
    const s = scripted([
      JSON.stringify({
        defects: [
          { id: "d1", status: "resolved", evidence: "bars now plotted" },
          { id: "d2", status: "open", evidence: "still missing" },
        ],
      }),
    ]);
    const c = await reviewClosure(shot, frozen, s.llm, "m");
    expect(c).not.toBeNull();
    expect(unresolvedDefects(frozen, c).map((d) => d.id)).toEqual(["d2"]);
  });

  it("reviewClosure returns [] for an empty frozen list WITHOUT calling the model", async () => {
    const s = scripted(["{}"]);
    expect(await reviewClosure(shot, [], s.llm, "m")).toEqual([]);
    expect(s.calls()).toBe(0);
  });

  it("reviewClosure returns null on persistent failure → treated as all-open by unresolvedDefects", async () => {
    const s = scripted([new Error("down"), new Error("down")]);
    const c = await reviewClosure(shot, frozen, s.llm, "m", 45_000, 2);
    expect(c).toBeNull();
    expect(unresolvedDefects(frozen, c)).toHaveLength(2);
  });
});
