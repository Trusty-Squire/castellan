import { execa } from "execa";
import { SquireError } from "../errors.js";
import type { LlmClient } from "./types.js";

/**
 * An LlmClient backed by the Claude Code CLI (`claude -p`), so model calls run
 * on the user's SUBSCRIPTION instead of burning metered API/OpenRouter tokens.
 * Used to drive the talk-eval iteration loop cheaply (A39): a Haiku worker for
 * the engine under test, a stronger Claude for the judges/simulated user.
 *
 * Tradeoff vs a raw API call: `claude -p` wraps the prompt in Claude Code's own
 * system prompt, so this is "Haiku-as-CC-agent", not a bare model. Good enough
 * to optimize the conversation against the eval; not a substitute for the live
 * cross-executor gauntlet.
 */

interface ClaudeCliResult {
  result?: string;
  is_error?: boolean;
  subtype?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Parse the `--output-format json` envelope into our LlmClient shape (pure). */
export function parseClaudeResult(stdout: string): { text: string; inTokens: number; outTokens: number; isError: boolean } {
  const env = JSON.parse(stdout) as ClaudeCliResult;
  return {
    text: String(env.result ?? ""),
    inTokens: env.usage?.input_tokens ?? 0,
    outTokens: env.usage?.output_tokens ?? 0,
    isError: env.is_error === true,
  };
}

/**
 * `claude -p` runs as a Claude Code AGENT, so it sometimes wraps JSON in
 * preamble ("I need to… {…}"). When the caller wants JSON, salvage the object
 * so the agent's narration doesn't break the parse downstream. Returns the
 * original text if no balanced object is found.
 */
export function extractJsonBlock(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start !== -1 && end > start ? text.slice(start, end + 1) : text;
}

export class ClaudeCliClient implements LlmClient {
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(opts: { bin?: string; timeoutMs?: number } = {}) {
    this.bin = opts.bin ?? "claude";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async complete(req: {
    model: string;
    system: string;
    user: string;
    json?: boolean;
    maxTokens: number;
  }): Promise<{ text: string; inTokens: number; outTokens: number }> {
    // The mapper's system prompt already instructs "output ONLY JSON" when it
    // needs JSON, so no special CLI mode is required — we just parse the text.
    const args = [
      "-p",
      "--model",
      req.model,
      "--output-format",
      "json",
      "--append-system-prompt",
      req.system,
      req.user,
    ];
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { stdout } = await execa(this.bin, args, { timeout: this.timeoutMs });
        const parsed = parseClaudeResult(stdout);
        if (parsed.isError) {
          lastErr = `claude -p error: ${parsed.text.slice(0, 200)}`;
          continue;
        }
        // The agent may narrate around requested JSON — salvage the object.
        const text = req.json ? extractJsonBlock(parsed.text) : parsed.text;
        // When JSON was asked for but the agent produced pure prose (no object
        // at all — common on sensitive prompts), retry: a fresh call almost
        // always returns JSON. Don't poison a run with the agent's narration.
        if (req.json && !text.includes("{")) {
          lastErr = `claude -p returned no JSON: ${parsed.text.slice(0, 80)}`;
          continue;
        }
        return { text, inTokens: parsed.inTokens, outTokens: parsed.outTokens };
      } catch (err) {
        lastErr = (err as Error).message.split("\n")[0] ?? "claude -p failed";
      }
    }
    throw new SquireError("LLM_RETRY", `ClaudeCliClient failed after retries: ${lastErr}`);
  }
}
