import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { SpecSession, applyDeltas, checkSpec, type DeltaBatch } from "../../src/contract/spec-session.js";
import { parseSpec } from "../../src/contract/spec.js";
import { MockLlm } from "../../src/llm/mock.js";
import { SquireError } from "../../src/errors.js";

const baseSpec = `
thesis: "cheap and reliable makes loops"
requirements:
  - id: R1
    statement: "compile specs"
    acceptance: { tier: 1, gate: "pnpm test" }
open_questions:
  - { id: Q1, text: "pricing?", blocking: true }
`;

let dir: string;
let specPath: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "spec-sess-"));
  specPath = join(dir, "product.spec.yaml");
  writeFileSync(specPath, baseSpec);
  await execa("git", ["init", "-q"], { cwd: dir });
  await execa("git", ["config", "user.email", "t@t.t"], { cwd: dir });
  await execa("git", ["config", "user.name", "t"], { cwd: dir });
  await execa("git", ["add", "-A"], { cwd: dir });
  await execa("git", ["commit", "-qm", "init"], { cwd: dir });
});

const batchAddDecision: DeltaBatch = {
  deltas: [
    {
      section: "claims",
      op: "add",
      value: { id: "C1", statement: "meter-watchers will adopt", status: "unverified", evidence: "" },
      drift: false,
    },
    {
      section: "decisions",
      op: "add",
      value: { id: "D1", statement: "lead with receipts", rationale: "H1/H2 research", claims: ["C1"] },
      drift: false,
    },
    { section: "open_questions", op: "resolve", id: "Q1", drift: false },
  ],
  question: "should the hosted tier ship in v0.3?",
  reply: "logged. receipts-first it is.",
  note: "mapped your pricing comment to D1 + resolved Q1",
  action: "none",
  action_arg: "",
  pivot: false,
  asking: "",
};

describe("applyDeltas (pure, validated)", () => {
  it("applies adds/resolves and re-validates", () => {
    const next = applyDeltas(parseSpec(baseSpec), batchAddDecision.deltas);
    expect(next.decisions[0]!.id).toBe("D1");
    expect(next.open_questions).toHaveLength(0);
  });

  it("refuses deltas that would invalidate the spec (unknown claim ref)", () => {
    expect(() =>
      applyDeltas(parseSpec(baseSpec), [
        { section: "decisions", op: "add", value: { id: "D1", statement: "x", rationale: "y", claims: ["C9"] }, drift: false },
      ]),
    ).toThrow(SquireError);
  });

  it("modify targets by id; missing targets throw", () => {
    expect(() =>
      applyDeltas(parseSpec(baseSpec), [{ section: "requirements", op: "modify", id: "R9", value: {}, drift: false }]),
    ).toThrow(/not found/);
  });
});

describe("SpecSession — guarantees the answer is recorded (A37)", () => {
  const ask = JSON.stringify({ reply: "what's the pricing?", deltas: [], question: "pricing?", asking: "Q1", action: "none" });

  it("records an answered question even when the model forgets to resolve it", async () => {
    // Turn 1 surfaces Q1; turn 2 the user answers but the model drops the record.
    const llm = new MockLlm([{ text: ask }, { text: JSON.stringify({ reply: "got it", deltas: [], action: "none" }) }]);
    const s = new SpecSession({ path: specPath, llm, executorModel: "cheap/x", knightModel: "frontier/y" });
    await s.turn("let's settle pricing"); // sets lastAsked = Q1
    const batch = await s.turn("freemium tier, no discounts");
    // the harness injected the resolve + a decision capturing the answer
    expect(batch.deltas.some((d) => d.section === "open_questions" && d.op === "resolve" && d.id === "Q1")).toBe(true);
    const decision = batch.deltas.find((d) => d.section === "decisions" && d.op === "add");
    expect(decision).toBeDefined();
    expect((decision!.value as { statement: string }).statement).toContain("freemium tier, no discounts");
    // applying it actually clears the blocking question — so it is never re-asked
    const next = applyDeltas(s.load(), batch.deltas);
    expect(next.open_questions).toHaveLength(0);
  });

  it("does NOT record a meta-request as the answer — it routes to status instead", async () => {
    const llm = new MockLlm([{ text: ask }, { text: JSON.stringify({ reply: "", deltas: [], action: "none" }) }]);
    const s = new SpecSession({ path: specPath, llm, executorModel: "cheap/x", knightModel: "frontier/y" });
    await s.turn("let's settle pricing"); // lastAsked = Q1
    const batch = await s.turn("present the architecture and user stories");
    expect(batch.action).toBe("status"); // show the plan, don't lock-in+ask
    expect(batch.deltas.some((d) => d.section === "open_questions" && d.op === "resolve")).toBe(false);
    expect(batch.deltas.some((d) => d.section === "decisions")).toBe(false);
  });
});

describe("SpecSession.reconcile — drop questions a decision already answers (A37)", () => {
  const answeredSpec = `
thesis: "a companion for my kid"
requirements:
  - id: R1
    statement: "voice loop"
    acceptance: { tier: 1, gate: "node --test" }
decisions:
  - id: D1
    statement: "designed for a 4-year-old child"
    rationale: "the user said she is 4"
open_questions:
  - { id: Q1, text: "what is the child's age?", blocking: true }
  - { id: Q2, text: "which laptop OS?", blocking: true }
`;

  it("resolves the question the decision answers, leaves the rest open", async () => {
    writeFileSync(specPath, answeredSpec);
    // the model identifies Q1 as answered by D1; the harness applies the resolve
    const llm = new MockLlm([{ text: JSON.stringify({ resolved: [{ question: "Q1", decision: "D1" }] }) }]);
    const s = new SpecSession({ path: specPath, llm, executorModel: "cheap/x", knightModel: "frontier/y" });
    const cleared = await s.reconcile();
    expect(cleared.map((d) => d.id)).toEqual(["Q1"]);
    const after = s.load();
    expect(after.open_questions.map((q) => q.id)).toEqual(["Q2"]);
  });

  it("makes NO call and resolves nothing when there are no decisions", async () => {
    writeFileSync(specPath, baseSpec); // Q1 blocking, zero decisions
    const llm = new MockLlm([]); // would throw if called
    const s = new SpecSession({ path: specPath, llm, executorModel: "cheap/x", knightModel: "frontier/y" });
    expect(await s.reconcile()).toEqual([]);
  });

  it("ignores ids the model invents (never resolves a question a decision doesn't justify)", async () => {
    writeFileSync(specPath, answeredSpec);
    const llm = new MockLlm([{ text: JSON.stringify({ resolved: [{ question: "Q2", decision: "D9" }] }) }]);
    const s = new SpecSession({ path: specPath, llm, executorModel: "cheap/x", knightModel: "frontier/y" });
    expect(await s.reconcile()).toEqual([]); // D9 isn't a real decision
  });
});

describe("SpecSession — the artifact is the state", () => {
  it("turn proposes deltas; accept applies, saves, git-commits; resume = new session reads same state", async () => {
    const llm = new MockLlm([{ text: JSON.stringify(batchAddDecision) }]);
    const s1 = new SpecSession({ path: specPath, llm, executorModel: "cheap/x", knightModel: "frontier/y" });
    const batch = await s1.turn("enterprises buy receipts, not discounts — log that and kill the pricing question");
    expect(batch.deltas).toHaveLength(3);
    await s1.accept(batch);

    // process "restart": a brand-new session sees the accepted state from disk
    const s2 = new SpecSession({ path: specPath, llm: new MockLlm([]), executorModel: "cheap/x", knightModel: "frontier/y" });
    const resumed = s2.load();
    expect(resumed.decisions[0]!.id).toBe("D1");
    expect(resumed.open_questions).toHaveLength(0);
    // and the acceptance is a git commit (checkpointed thinking)
    const log = await execa("git", ["log", "--oneline"], { cwd: dir });
    expect(log.stdout).toContain("spec(product.spec.yaml): 3 delta(s)");
  });

  it("turn → acceptLenient lands a realistically SLOPPY mapper batch (dotted/omitted ids)", async () => {
    // What the real cheap model actually emits: split a requirement with dotted
    // ids, omit an id, carry an object thesis. All must land, none drop.
    const sloppy = {
      reply: "split into capabilities",
      deltas: [
        { section: "thesis", op: "modify", value: { statement: "a kids voice companion" } },
        { section: "requirements", op: "add", value: { id: "R1.1", statement: "voice loop", acceptance: { tier: 1, gate: "node --test" } } },
        { section: "requirements", op: "add", value: { statement: "safety", acceptance: { tier: 4, artifact: "s.md" } } },
      ],
    };
    const llm = new MockLlm([{ text: JSON.stringify(sloppy) }]);
    const s = new SpecSession({ path: specPath, llm, executorModel: "cheap/x", knightModel: "frontier/y" });
    const batch = await s.turn("split it into voice and safety");
    const { applied, dropped } = await s.acceptLenient(batch);
    expect(dropped).toHaveLength(0); // nothing lost to sloppiness
    expect(applied.length).toBeGreaterThanOrEqual(3);
    const final = s.load();
    expect(final.thesis).toBe("a kids voice companion");
    expect(final.requirements.every((r) => /^R\d+$/.test(r.id))).toBe(true);
    expect(final.requirements.length).toBeGreaterThanOrEqual(2);
  });

  it("bounded context: each turn sends current spec + last message only (no transcript)", async () => {
    const llm = new MockLlm([{ text: JSON.stringify(batchAddDecision) }, { text: JSON.stringify({ deltas: [], question: "", note: "" }) }]);
    const s = new SpecSession({ path: specPath, llm, executorModel: "cheap/x", knightModel: "frontier/y" });
    await s.accept(await s.turn("first message"));
    await s.turn("second message");
    // second call's user content contains the SPEC and the SECOND message, not the first
    expect(llm.calls[1]!.user).toContain("second message");
    expect(llm.calls[1]!.user).not.toContain("first message");
  });

  it("two consecutive rejections escalate generative turns to the knight", async () => {
    const llm = new MockLlm([
      { text: JSON.stringify({ deltas: [], question: "", note: "" }) },
      { text: JSON.stringify({ deltas: [], question: "", note: "" }) },
      { text: JSON.stringify({ deltas: [], question: "", note: "" }) },
    ]);
    const s = new SpecSession({ path: specPath, llm, executorModel: "cheap/x", knightModel: "frontier/y" });
    await s.turn("a");
    s.reject();
    await s.turn("b");
    s.reject();
    expect(s.currentModel()).toBe("frontier/y");
    await s.turn("c");
    expect(llm.calls.map((c) => c.model)).toEqual(["cheap/x", "cheap/x", "frontier/y"]);
  });
});

describe("checkSpec — the five gates, mechanical subset", () => {
  it("fails on blocking questions + unverified load-bearing claims, passes when resolved", () => {
    const withDecision = applyDeltas(parseSpec(baseSpec), batchAddDecision.deltas);
    const r1 = checkSpec(withDecision);
    expect(r1.ok).toBe(false);
    expect(r1.lines.join("\n")).toContain("rests on C1");

    const verified = applyDeltas(withDecision, [
      { section: "claims", op: "modify", id: "C1", value: { status: "verified", evidence: "https://example.com/research" }, drift: false },
    ]);
    const r2 = checkSpec(verified);
    expect(r2.ok).toBe(true);
    expect(r2.lines.join("\n")).toContain("READY to compile");
  });
});

describe("bookkeeping never kills the conversation", () => {
  it("salvageBatch keeps reply/question and individually-valid deltas", async () => {
    const { salvageBatch } = await import("../../src/contract/spec-session.js");
    const b = salvageBatch({
      reply: "build a voice loop on a Pi",
      question: "voice only?",
      deltas: [
        { section: "claims", op: "add", value: { id: "C1", statement: "x" } }, // valid
        { section: "nonsense", op: "add" }, // invalid section — dropped
      ],
    });
    expect(b.reply).toContain("voice loop");
    expect(b.deltas).toHaveLength(1);
  });

  it("applyDeltasLenient applies the good edits and reports the bad", async () => {
    const { applyDeltasLenient } = await import("../../src/contract/spec-session.js");
    const spec = parseSpec(baseSpec);
    const r = applyDeltasLenient(spec, [
      { section: "claims", op: "add", value: { id: "C1", statement: "ok", status: "unverified", evidence: "" }, drift: false },
      { section: "decisions", op: "add", value: { id: "D1", statement: "bad", rationale: "r", claims: ["C99"] }, drift: false },
    ]);
    expect(r.applied).toHaveLength(1);
    expect(r.dropped).toHaveLength(1);
    expect(r.spec.claims[0]!.id).toBe("C1");
    expect(r.dropped[0]!.reason).toContain("C99");
  });
});

describe("pivot reset (a new product clears the old spec — dogfood 2026-06-13)", () => {
  const companion = `
thesis: "an ambient ai companion for my daughter"
requirements:
  - id: R1
    statement: "voice input/output"
    acceptance: { tier: 1, gate: "node --test voice" }
  - id: R2
    statement: "child-safe content filtering"
    acceptance: { tier: 1, gate: "node --test safety" }
`;

  it("a drift-thesis pivot resets stale requirements instead of appending", async () => {
    const { isPivot } = await import("../../src/contract/spec-session.js");
    // the cheap model emits: pivot the thesis (drift) + add poker requirements
    const llm = new MockLlm([{ text: JSON.stringify({
      reply: "poker bot is a new product",
      deltas: [
        { section: "thesis", op: "modify", value: "a GTO poker bot for no-limit holdem", drift: true },
        { section: "requirements", op: "add", value: { statement: "GTO strategy engine", acceptance: { tier: 1, gate: "node --test gto" } } },
        { section: "requirements", op: "add", value: { statement: "real-time betting decisions", acceptance: { tier: 1, gate: "node --test bet" } } },
      ],
    }) }]);
    const dir = mkdtempSync(join(tmpdir(), "pivot-"));
    const p = join(dir, "x.spec.yaml");
    writeFileSync(p, companion);
    const s = new SpecSession({ path: p, llm, executorModel: "m", knightModel: "k", git: false });
    const batch = await s.turn("id like to build a GTO poker bot for no limit holdem");
    expect(batch.pivot).toBe(true);
    expect(isPivot(batch.deltas)).toBe(true);
    await s.acceptLenient(batch);
    const next = s.load();
    expect(next.thesis).toContain("poker bot");
    // the companion requirements are GONE; only poker ones remain
    const statements = next.requirements.map((r) => r.statement).join(" ");
    expect(statements).not.toMatch(/voice|child-safe/i);
    expect(statements).toMatch(/GTO|betting/i);
  });

  it("a NON-drift edit appends as usual (no reset)", async () => {
    const { isPivot } = await import("../../src/contract/spec-session.js");
    expect(isPivot([{ section: "requirements", op: "add", value: { id: "R3" }, drift: false }])).toBe(false);
    expect(isPivot([{ section: "thesis", op: "modify", value: "x", drift: false }])).toBe(false);
  });
});

describe("normalizeDeltas (the user's words must land — dogfood 2026-06-13)", () => {
  const blank = `
thesis: "TODO: one paragraph — pinned; drift is flagged against this"
requirements:
  - id: R1
    statement: "TODO"
    acceptance: { tier: 0 }
open_questions:
  - { id: Q1, text: "first check?", blocking: true }
`;

  it("thesis modify carrying an object is coerced to its string (was dropped)", async () => {
    const { normalizeDeltas } = await import("../../src/contract/spec-session.js");
    const spec = parseSpec(blank);
    const fixed = normalizeDeltas(spec, [
      { section: "thesis", op: "modify", value: { statement: "an ambient ai companion" }, drift: false },
    ]);
    expect(fixed[0]!.value).toBe("an ambient ai companion");
    // and it now applies cleanly
    expect(applyDeltas(spec, fixed).thesis).toBe("an ambient ai companion");
  });

  it("a requirements modify with NO id fills the R1 TODO placeholder (was 'undefined not found')", async () => {
    const { normalizeDeltas } = await import("../../src/contract/spec-session.js");
    const spec = parseSpec(blank);
    const fixed = normalizeDeltas(spec, [
      { section: "requirements", op: "modify", value: { statement: "build an ai companion for my daughter" }, drift: false },
    ]);
    expect(fixed[0]).toMatchObject({ op: "modify", id: "R1" });
    const next = applyDeltas(spec, fixed);
    expect(next.requirements[0]!.statement).toContain("companion");
    expect(next.requirements).toHaveLength(1); // filled R1, didn't add R2
  });

  it("a requirement add while the placeholder exists fills R1 instead of stacking a TODO", async () => {
    const { normalizeDeltas } = await import("../../src/contract/spec-session.js");
    const spec = parseSpec(blank);
    const fixed = normalizeDeltas(spec, [
      { section: "requirements", op: "add", value: { statement: "voice interface", acceptance: { tier: 0 } }, drift: false },
    ]);
    const next = applyDeltas(spec, fixed);
    expect(next.requirements).toHaveLength(1);
    expect(next.requirements[0]!.statement).toBe("voice interface");
  });

  it("a modify to an unknown id with a full value upserts as an add", async () => {
    const { normalizeDeltas } = await import("../../src/contract/spec-session.js");
    const spec = parseSpec(baseSpec); // R1 is real (not a placeholder)
    const fixed = normalizeDeltas(spec, [
      { section: "claims", op: "modify", id: "C1", value: { id: "C1", statement: "x", status: "unverified", evidence: "" }, drift: false },
    ]);
    expect(fixed[0]!.op).toBe("add");
    expect(applyDeltas(spec, fixed).claims[0]!.id).toBe("C1");
  });

  it("leaves a well-formed modify to an existing id untouched", async () => {
    const { normalizeDeltas } = await import("../../src/contract/spec-session.js");
    const spec = parseSpec(baseSpec);
    const fixed = normalizeDeltas(spec, [
      { section: "requirements", op: "modify", id: "R1", value: { statement: "compile specs v2" }, drift: false },
    ]);
    expect(fixed[0]).toMatchObject({ op: "modify", id: "R1" });
    expect(applyDeltas(spec, fixed).requirements[0]!.statement).toBe("compile specs v2");
  });

  it("harness mints ids for adds that OMIT id entirely (model no longer assigns them)", async () => {
    const { normalizeDeltas } = await import("../../src/contract/spec-session.js");
    const spec = parseSpec(baseSpec);
    const fixed = normalizeDeltas(spec, [
      { section: "requirements", op: "add", value: { statement: "voice", acceptance: { tier: 1, gate: "t" } }, drift: false },
      { section: "requirements", op: "add", value: { statement: "safety", acceptance: { tier: 4, artifact: "a.md" } }, drift: false },
    ]);
    const next = applyDeltas(spec, fixed);
    const ids = next.requirements.map((r) => r.id);
    expect(ids.every((i) => /^R\d+$/.test(i))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length); // distinct
  });

  it("an intra-batch decision keeps pointing at a claim added the same turn (handle remap)", async () => {
    const { normalizeDeltas } = await import("../../src/contract/spec-session.js");
    const spec = parseSpec(baseSpec);
    const fixed = normalizeDeltas(spec, [
      // model uses a free-form handle "feasible" for the new claim, dotted/garbage id
      { section: "claims", op: "add", value: { id: "feasible", statement: "GTO is tractable", status: "unverified", evidence: "" }, drift: false },
      { section: "decisions", op: "add", value: { id: "d.x", statement: "use CFR", rationale: "r", claims: ["feasible"] }, drift: false },
    ]);
    const next = applyDeltas(spec, fixed);
    const claimId = next.claims[0]!.id;
    expect(claimId).toMatch(/^C\d+$/);
    expect(next.decisions[0]!.id).toMatch(/^D\d+$/);
    expect(next.decisions[0]!.claims).toEqual([claimId]); // reference rewritten to the minted id
  });

  it("accepts the model's NATURAL op-keyed shape (captured real qwen output)", async () => {
    const { coerceRawDeltas, normalizeDeltas } = await import("../../src/contract/spec-session.js");
    const spec = parseSpec(baseSpec); // R1 real, Q1 open
    // exactly the shape the live model returned: op-keyed, section-batched
    const realShape = [
      { add: { requirements: [
        { statement: "voice interaction", acceptance: { tier: 1, gate: "node --test voice" } },
        { statement: "emotional modeling", acceptance: { tier: 4, artifact: "emo.log" } },
      ] } },
      { remove: { requirements: ["R1"] } },
      { add: { decisions: [{ statement: "ser default: raspberry pi", rationale: "affordable", claims: [] }] } },
      { resolve: { open_questions: ["Q1"] } },
    ];
    const canonical = coerceRawDeltas(realShape);
    // 2 requirement adds + 1 remove + 1 decision add + 1 resolve = 5 flat deltas
    expect(canonical).toHaveLength(5);
    const next = applyDeltas(spec, normalizeDeltas(spec, canonical as never));
    expect(next.requirements.find((r) => r.id === "R1")).toBeUndefined(); // removed
    expect(next.requirements.length).toBe(2); // the two new capabilities
    expect(next.requirements.every((r) => /^R\d+$/.test(r.id))).toBe(true);
    expect(next.decisions[0]!.statement).toContain("ser default");
    expect(next.open_questions).toHaveLength(0); // Q1 resolved
  });

  it("an unresolvable remove/resolve drops silently instead of throwing", async () => {
    const { normalizeDeltas } = await import("../../src/contract/spec-session.js");
    const spec = parseSpec(baseSpec);
    const fixed = normalizeDeltas(spec, [
      { section: "requirements", op: "remove", id: "R99", drift: false },
      { section: "open_questions", op: "resolve", id: "Q1", drift: false },
    ]);
    // R99 removal dropped; Q1 resolve kept
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toMatchObject({ section: "open_questions", op: "resolve", id: "Q1" });
  });
});

describe("self-knowledge composition (no architectural drift between prompts)", () => {
  it("spec-talk and derive prompts share the canonical gate ladder and identity", async () => {
    const { DELTA_MAPPER_PROMPT } = await import("../../src/contract/spec-session.js");
    const { CASTELLAN_IDENTITY, GATE_LADDER_DOC, gatePatternDoc } = await import("../../src/contract/self-knowledge.js");
    const { GATE_PATTERNS } = await import("../../src/contract/gate-patterns.js");
    expect(DELTA_MAPPER_PROMPT).toContain(CASTELLAN_IDENTITY);
    expect(DELTA_MAPPER_PROMPT).toContain("tier 4 in a costume");
    expect(CASTELLAN_IDENTITY).toContain("never grades its own homework");
    expect(GATE_LADDER_DOC).toContain("tier 4 (human)");
    // dogfood 2026-06-11: "build it" made spec-talk roleplay a completed build
    // ("Demo ready") and try to resolve requirements to match its own fiction.
    expect(DELTA_MAPPER_PROMPT.replace(/\s+/g, " ")).toContain("NEVER claim work was performed");
    // dogfood 2026-06-13: mapper must propose gates and not interrogate, and
    // must capture the stated goal instead of asking the user to repeat it
    expect(DELTA_MAPPER_PROMPT).toContain("PROPOSE gates; never interrogate");
    expect(DELTA_MAPPER_PROMPT).toContain("NEVER re-ask");
    // raises the load-bearing forks (changes a gate/decision/feasibility) as
    // blocking questions, and decomposes a product into capabilities
    expect(DELTA_MAPPER_PROMPT).toContain("changes a GATE, a DECISION, or a FEASIBILITY");
    expect(DELTA_MAPPER_PROMPT).toContain("BLOCKING open_question");
    expect(DELTA_MAPPER_PROMPT).toContain("decompose it into the CAPABILITIES");
    // dogfood 2026-06-13: resolve answered questions; default tech, don't ask
    expect(DELTA_MAPPER_PROMPT).toContain("emit op:resolve for that open_question");
    expect(DELTA_MAPPER_PROMPT).toContain("TECHNICAL choices are YOURS to default");
    expect(DELTA_MAPPER_PROMPT.replace(/\s+/g, " ")).toContain("thesis modify value is ALWAYS a plain string");
    // unified interface: the mapper requests harness commands, never performs them
    expect(DELTA_MAPPER_PROMPT).toContain('setting "action"');
    for (const a of ["check", "verify", "derive", "run", "status"]) {
      expect(DELTA_MAPPER_PROMPT).toContain(`${a} `);
    }
    expect(CASTELLAN_IDENTITY).toContain("claiming work that was not performed is the exact failure Castellan exists to kill");
    const { SPEC_ITEM_SHAPES } = await import("../../src/contract/self-knowledge.js");
    expect(SPEC_ITEM_SHAPES).toContain("resolve ONLY on");
    // pattern doc is GENERATED from the library — every pattern id present, forever
    const doc = gatePatternDoc();
    for (const p of GATE_PATTERNS) expect(doc).toContain(p.id);
  });
});
