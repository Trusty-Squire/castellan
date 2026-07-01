import { describe, it, expect } from "vitest";
import { bucketOf, converseIdea, discussIdea, EMPTY_BRIEF, extractIdea, fallbackIdeaFromPrompt, renderIdea } from "../../src/contract/ingest.js";
import { MockLlm } from "../../src/llm/mock.js";

describe("bucketOf (the 3-test, code-owned)", () => {
  it("not forks-hard → bucket 3 (silent trivia) regardless of the rest", () => {
    expect(bucketOf({ forksHard: false, canGuess: false, costlyToUndo: true })).toBe(3);
    expect(bucketOf({ forksHard: false, canGuess: true, costlyToUndo: false })).toBe(3);
  });
  it("forks-hard but guessable OR cheap-to-undo → bucket 2 (default + flag)", () => {
    expect(bucketOf({ forksHard: true, canGuess: true, costlyToUndo: true })).toBe(2); // guessable
    expect(bucketOf({ forksHard: true, canGuess: false, costlyToUndo: false })).toBe(2); // cheap to flip
  });
  it("forks-hard AND can't-guess AND costly-to-undo → bucket 1 (ASK NOW)", () => {
    expect(bucketOf({ forksHard: true, canGuess: false, costlyToUndo: true })).toBe(1);
  });
  it("the only path to ASK is the full conjunction (no other combo asks)", () => {
    let asks = 0;
    for (const forksHard of [true, false])
      for (const canGuess of [true, false])
        for (const costlyToUndo of [true, false])
          if (bucketOf({ forksHard, canGuess, costlyToUndo }) === 1) asks++;
    expect(asks).toBe(1); // exactly one of the 8 combinations asks
  });
});

describe("idea conversation JSON repair", () => {
  it("repairs malformed conversation JSON", async () => {
    const current = {
      stories: ["old story"],
      components: [{ statement: "old component", story: "old story", gate: { tier: 1, gate: "node --test" } }],
      decisions: [],
    };
    const llm = new MockLlm([
      { text: '{"reply":"ok","stories":["new story"],"components":[],"decisions":[' },
      {
        text: JSON.stringify({
          reply: "fixed",
          stories: ["new story"],
          components: [{ statement: "new component", story: "new story", gate: { tier: 1, gate: "node --test" } }],
          decisions: [],
        }),
      },
    ]);

    const result = await converseIdea("x", current, [], "make it concrete", llm, "m");
    expect(result.reply).toBe("fixed");
    expect(result.idea.stories).toEqual(["new story"]);
    expect(llm.calls).toHaveLength(2);
  });

  it("repairs malformed discussion JSON", async () => {
    const llm = new MockLlm([
      { text: '{"reply":"almost","brief":{"intent":"notes","outcomes":["works"],"forWhom":"","nonGoals":[],"constraints":[]},"ready":' },
      { text: JSON.stringify({ reply: "ready", brief: { ...EMPTY_BRIEF, intent: "notes", outcomes: ["works"] }, ready: true }) },
    ]);

    const result = await discussIdea([], "build notes", EMPTY_BRIEF, llm, "m");
    expect(result.reply).toBe("ready");
    expect(result.brief.intent).toBe("notes");
    expect(result.ready).toBe(true);
  });
});

describe("extractIdea (buckets derived in code from the model's facts)", () => {
  const sample = {
    stories: ["she asks a question and gets a kid-safe answer", "it greets her when she walks in"],
    components: [
      { statement: "voice question answering", story: "asks a question", gate: { tier: 1, gate: "node --test voice" } },
      { statement: "presence detection", story: "greets her", gate: { tier: 1, gate: "node --test presence" } },
    ],
    decisions: [
      // ASK: hardware — can't guess, forks hard, costly
      { question: "target hardware?", why: "changes every gate", recommendation: "Pi 4", alternatives: ["phone"], canGuess: false, forksHard: true, costlyToUndo: true },
      // DEFAULT: latency — guessable
      { question: "latency budget?", why: "perf gate", recommendation: "2s", alternatives: ["1s"], canGuess: true, forksHard: true, costlyToUndo: false },
      // SILENT: greeting wording — cosmetic
      { question: "greeting wording?", why: "copy", recommendation: "Hi!", alternatives: [], canGuess: true, forksHard: false, costlyToUndo: false },
    ],
  };

  it("classifies a realistic mix into ask / default / silent", async () => {
    const llm = new MockLlm([{ text: JSON.stringify(sample) }]);
    const r = await extractIdea("an ambient ai companion for my daughter", llm, "m");
    expect(r.stories).toHaveLength(2);
    expect(r.components).toHaveLength(2);
    const byBucket = (b: number) => r.decisions.filter((d) => d.bucket === b).map((d) => d.question);
    expect(byBucket(1)).toEqual(["target hardware?"]);
    expect(byBucket(2)).toEqual(["latency budget?"]);
    expect(byBucket(3)).toEqual(["greeting wording?"]);
  });

  it("renderIdea summarizes the counts and surfaces the ASK decisions", async () => {
    const llm = new MockLlm([{ text: JSON.stringify(sample) }]);
    const lines = renderIdea(await extractIdea("x", llm, "m")).join("\n");
    expect(lines).toContain("1 ask, 1 default, 1 silent");
    expect(lines).toContain("[ASK]  target hardware?");
    expect(lines).toContain("[auto] latency budget?");
  });

  it("throws a clear error on non-JSON model output", async () => {
    const llm = new MockLlm([{ text: "sorry, here is a paragraph instead" }]);
    await expect(extractIdea("x", llm, "m")).rejects.toThrow(/idea phase/);
  });

  it("repairs malformed idea JSON before failing the planner", async () => {
    const llm = new MockLlm([
      { text: '{"stories":["one"],"components":[],"decisions":[{"question":"q?","canGuess":false,"forksHard":true,"costlyToUndo":true,' },
      { text: JSON.stringify(sample) },
    ]);

    const r = await extractIdea("x", llm, "m");
    expect(r.stories).toEqual(sample.stories);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]!.system).toContain("repair malformed JSON");
  });

  it("repairs schema-invalid idea JSON", async () => {
    const llm = new MockLlm([
      { text: JSON.stringify({ stories: ["one"], decisions: [{ question: "q?" }] }) },
      { text: JSON.stringify(sample) },
    ]);

    const r = await extractIdea("x", llm, "m");
    expect(r.components).toHaveLength(2);
    expect(llm.calls[1]!.user).toContain("failed to parse or validate");
  });

  it("repairs unanchored component gates before spec generation", async () => {
    const llm = new MockLlm([
      {
        text: JSON.stringify({
          stories: ["create notes"],
          components: [{ statement: "note editor", story: "create notes", gate: { tier: 0 } }],
          decisions: [],
        }),
      },
      { text: JSON.stringify(sample) },
    ]);

    const r = await extractIdea("x", llm, "m");
    expect(r.components[0]!.gate.tier).toBe(1);
    expect(llm.calls).toHaveLength(2);
  });

  it("repairs story-only idea output before spec generation", async () => {
    const llm = new MockLlm([
      { text: JSON.stringify({ stories: ["create notes"], components: [], decisions: [] }) },
      { text: JSON.stringify(sample) },
    ]);

    const r = await extractIdea("x", llm, "m");
    expect(r.components).toHaveLength(2);
    expect(llm.calls[1]!.system).toContain("repair malformed JSON");
  });
});

describe("fallbackIdeaFromPrompt", () => {
  it("keeps a failed idea phase moving with a minimal scoped seed", () => {
    const idea = fallbackIdeaFromPrompt("build a small local notes tool");
    expect(idea.stories).toEqual(["I can use build a small local notes tool for its core workflow."]);
    expect(idea.components).toEqual([
      {
        statement: "Implement the smallest useful version of: build a small local notes tool",
        story: "I can use build a small local notes tool for its core workflow.",
        gate: { tier: 1, gate: "npm test -- --runInBand" },
      },
    ]);
    expect(idea.decisions).toEqual([]);
  });
});
