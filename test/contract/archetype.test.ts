import { describe, it, expect } from "vitest";
import { classifyArchetype, parseArchetype, WEB_APP_STACK_RULE } from "../../src/contract/archetype.js";
import { MockLlm } from "../../src/llm/mock.js";

describe("parseArchetype — tolerant of casing/punctuation/extra words", () => {
  it("recognizes each archetype", () => {
    expect(parseArchetype("web-app")).toBe("web-app");
    expect(parseArchetype("This is a CLI tool.")).toBe("cli");
    expect(parseArchetype("library")).toBe("library");
    expect(parseArchetype("a data pipeline")).toBe("pipeline");
    expect(parseArchetype("bot")).toBe("bot");
    expect(parseArchetype("creative")).toBe("creative");
  });
  it("accepts the spaced form and the hyphenated form of web app", () => {
    expect(parseArchetype("web app")).toBe("web-app");
    expect(parseArchetype("Archetype: web-app")).toBe("web-app");
  });
  it("defaults to other on an unknown reply", () => {
    expect(parseArchetype("I'm not sure")).toBe("other");
    expect(parseArchetype("")).toBe("other");
  });
});

describe("classifyArchetype", () => {
  it("returns the classified archetype from a cheap model reply", async () => {
    const llm = new MockLlm([{ text: "web-app" }]);
    expect(await classifyArchetype(llm, "qwen/qwen3-coder", "a dashboard to track my habits")).toBe("web-app");
    expect(llm.calls[0]!.user).toContain("a dashboard to track my habits");
  });
  it("defaults to other when the model errors (no steering, safe fallback)", async () => {
    const llm = new MockLlm([() => { throw new Error("boom"); }]);
    expect(await classifyArchetype(llm, "qwen/qwen3-coder", "x")).toBe("other");
  });
});

describe("WEB_APP_STACK_RULE", () => {
  it("steers to the scaffold-supported stack (Node + static, no React/Flask/db)", () => {
    expect(WEB_APP_STACK_RULE).toMatch(/Node\.js \+ Express/);
    expect(WEB_APP_STACK_RULE).toMatch(/static/i);
    expect(WEB_APP_STACK_RULE).toMatch(/NO React/);
    expect(WEB_APP_STACK_RULE).toMatch(/process\.env\.PORT/);
  });
});
