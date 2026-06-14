import { describe, it, expect } from "vitest";
import { parseClaudeResult } from "../../src/llm/claude-cli.js";

describe("parseClaudeResult", () => {
  it("extracts text + usage from the claude -p json envelope", () => {
    const env = JSON.stringify({
      type: "result",
      is_error: false,
      result: '{"reply":"hi"}',
      usage: { input_tokens: 12, output_tokens: 5 },
    });
    expect(parseClaudeResult(env)).toEqual({ text: '{"reply":"hi"}', inTokens: 12, outTokens: 5, isError: false });
  });

  it("flags an error envelope", () => {
    const env = JSON.stringify({ is_error: true, subtype: "error_max_turns", result: "boom" });
    const r = parseClaudeResult(env);
    expect(r.isError).toBe(true);
    expect(r.text).toBe("boom");
  });
});
