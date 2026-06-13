import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchAction, missionPathFor, ensureSpecFile, blankSpec, renderPlan, type TalkActionContext } from "../../src/contract/talk.js";
import { DeltaBatchSchema, salvageBatch, DELTA_MAPPER_PROMPT } from "../../src/contract/spec-session.js";
import { parseSpec } from "../../src/contract/spec.js";
import { SquireError } from "../../src/errors.js";
import { stringify as yamlStringify } from "yaml";
import type { LlmClient } from "../../src/llm/types.js";

const readySpec = `
thesis: "a fox companion for kids"
requirements:
  - id: R1
    statement: "core loop"
    acceptance: { tier: 1, gate: "node --test" }
`;

const unreadySpec = `
thesis: "a fox companion for kids"
requirements:
  - id: R1
    statement: "feels alive"
    acceptance: { tier: 0 }
open_questions:
  - { id: Q1, text: "what hardware?", blocking: true }
`;

// Decomposed + gated + scoped → clears the readiness score mechanically.
const buildReadySpec = `
thesis: "a fox companion for kids"
scope_fence:
  - "no cloud — offline only"
  - "no open web access"
requirements:
  - id: R1
    statement: "voice interaction loop"
    acceptance: { tier: 1, gate: "node --test loop" }
  - id: R2
    statement: "child-safe content"
    acceptance: { tier: 4, artifact: "review.md" }
`;

const mission = `
goal: "fox companion"
budget_usd: 1
chain: cheap
nodes:
  - id: loop
    brief: "build the loop"
    blast_radius: ["**"]
    done_check: "node --test"
    budget_usd: 0.5
`;

/** An LlmClient that must never be reached — proves dispatch is mechanical. */
const deadLlm: LlmClient = {
  complete: () => {
    throw new Error("LLM must not be called for this action");
  },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "talk-"));
});

function ctx(specPath: string, extra?: Partial<TalkActionContext>): TalkActionContext {
  return { specPath, llm: deadLlm, executorModel: "m", chainName: "cheap", ...extra };
}

describe("the action field (mapper requests, harness executes)", () => {
  it("DeltaBatchSchema defaults action to none; salvage keeps valid actions and drops junk", () => {
    expect(DeltaBatchSchema.parse({ deltas: [] }).action).toBe("none");
    expect(salvageBatch({ action: "run", deltas: [] }).action).toBe("run");
    expect(salvageBatch({ action: "rm -rf /", deltas: [] }).action).toBe("none");
    expect(salvageBatch({ action: "verify", action_arg: "C2", deltas: [] }).action_arg).toBe("C2");
  });
});

describe("ensureSpecFile (talk is always runnable)", () => {
  it("empty directory: creates <dirname>.spec.yaml with valid TODO placeholders", () => {
    const r = ensureSpecFile(dir);
    expect(r.created).toBe(true);
    expect(r.path.endsWith(".spec.yaml")).toBe(true);
    const spec = parseSpec(readFileSync(r.path, "utf8"), r.path);
    expect(spec.thesis).toContain("TODO");
    expect(spec.requirements[0]!.acceptance.tier).toBe(0);
  });

  it("sole existing spec is picked up, not recreated", () => {
    const p = join(dir, "x.spec.yaml");
    writeFileSync(p, readySpec);
    const r = ensureSpecFile(dir);
    expect(r).toEqual({ path: p, created: false });
    expect(readFileSync(p, "utf8")).toBe(readySpec); // untouched
  });

  it("explicit missing path is created; multiple specs without an arg throw", () => {
    const r = ensureSpecFile(dir, "newidea.spec.yaml");
    expect(r.created).toBe(true);
    writeFileSync(join(dir, "other.spec.yaml"), readySpec);
    expect(() => ensureSpecFile(dir)).toThrow(SquireError);
  });

  it("blankSpec round-trips through parseSpec and the mapper knows the TODO-seeding rule", () => {
    const spec = parseSpec(yamlStringify(blankSpec("a fox companion")), "blank");
    expect(spec.thesis).toBe("a fox companion");
    expect(DELTA_MAPPER_PROMPT).toContain("TODO placeholder");
  });
});

describe("dispatchAction (mechanical, no LLM unless the action needs one)", () => {
  it("check on an unready spec reports NOT ready without any LLM call", async () => {
    const p = join(dir, "x.spec.yaml");
    writeFileSync(p, unreadySpec);
    const lines = await dispatchAction("check", "", ctx(p));
    expect(lines.join("\n")).toContain("NOT ready");
  });

  it("renderPlan lists each requirement with its gate, plus decisions", () => {
    const spec = parseSpec(buildReadySpec);
    const out = renderPlan(spec).join("\n");
    expect(out).toContain("R1 voice interaction loop [tier1: node --test loop]");
    expect(out).toContain("R2 child-safe content [tier4 artifact: review.md]");
    expect(out).toContain("thesis: a fox companion for kids");
  });

  it("status presents the full plan (thesis, requirements + gates) then the gates", async () => {
    const p = join(dir, "x.spec.yaml");
    writeFileSync(p, readySpec);
    const lines = await dispatchAction("status", "", ctx(p));
    const out = lines.join("\n");
    expect(lines[0]).toContain("thesis:");
    expect(out).toContain("requirements (1)");
    expect(out).toContain("READY to compile");
  });

  it("verify with nothing to verify says so without an LLM call", async () => {
    const p = join(dir, "x.spec.yaml");
    writeFileSync(p, readySpec);
    const lines = await dispatchAction("verify", "", ctx(p));
    expect(lines[0]).toContain("nothing to verify");
  });

  it("run on an unready spec is blocked by the readiness gate — execute is never reached", async () => {
    const p = join(dir, "x.spec.yaml");
    writeFileSync(p, unreadySpec);
    let executed = false;
    const lines = await dispatchAction("run", "", ctx(p, {
      execute: async () => { executed = true; return 0; },
      confirm: async () => true,
    }));
    expect(executed).toBe(false);
    const txt = lines.join("\n");
    expect(txt).toContain("not building yet");
    expect(txt).toContain("not buildable");
    expect(txt).toContain("R1 has no objective check"); // the blocking gap is surfaced
  });

  it("run with a fresh mission asks to confirm spend; unconfirmed = cancelled", async () => {
    const p = join(dir, "x.spec.yaml");
    writeFileSync(p, buildReadySpec);
    const mp = missionPathFor(p);
    writeFileSync(mp, mission);
    const future = new Date(Date.now() + 60_000);
    utimesSync(mp, future, future); // mission newer than spec — no re-derive
    let executed = false;
    let asked = "";
    const lines = await dispatchAction("run", "", ctx(p, {
      execute: async () => { executed = true; return 0; },
      confirm: async (q) => { asked = q; return false; },
    }));
    expect(asked).toContain("budget $1");
    expect(executed).toBe(false);
    expect(lines.join("\n")).toContain("cancelled");
  });

  it("run confirmed executes the mission and reports the harness verdict", async () => {
    const p = join(dir, "x.spec.yaml");
    writeFileSync(p, buildReadySpec);
    const mp = missionPathFor(p);
    writeFileSync(mp, mission);
    const future = new Date(Date.now() + 60_000);
    utimesSync(mp, future, future);
    const ran: string[] = [];
    const lines = await dispatchAction("run", "", ctx(p, {
      execute: async (path) => { ran.push(path); return 0; },
      confirm: async () => true,
    }));
    expect(ran).toEqual([mp]);
    expect(lines.join("\n")).toContain("every gate green");
  });

  it("run without an executor degrades politely", async () => {
    const p = join(dir, "x.spec.yaml");
    writeFileSync(p, readySpec);
    const lines = await dispatchAction("run", "", ctx(p));
    expect(lines[0]).toContain("not available");
  });
});
