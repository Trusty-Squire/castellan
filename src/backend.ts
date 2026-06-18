/**
 * Backend selection: the model provider for planning (LlmClient) and build
 * execution (Engine). Default is OpenRouter (metered API). Set SER_BACKEND=codex
 * to run BOTH on the local Codex CLI subscription instead — no API key, no egress
 * grant, no per-token cost.
 */
import type { LlmClient } from "./llm/types.js";
import type { Engine } from "./engine/types.js";
import { SquireError } from "./errors.js";

export type BackendName = "openrouter" | "codex";

export function backendName(env: NodeJS.ProcessEnv = process.env): BackendName {
  return env.SER_BACKEND === "codex" ? "codex" : "openrouter";
}

/** The planning/authoring LlmClient for the configured backend. */
export async function makeLlmClient(env: NodeJS.ProcessEnv = process.env): Promise<LlmClient> {
  if (backendName(env) === "codex") {
    const { CodexCliClient } = await import("./llm/codex-cli.js");
    return new CodexCliClient();
  }
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new SquireError("NO_API_KEY", "OPENROUTER_API_KEY required (or set SER_BACKEND=codex)");
  const { OpenRouterClient } = await import("./llm/openrouter.js");
  return new OpenRouterClient({ apiKey, baseUrl: env.OPENROUTER_BASE_URL });
}

/**
 * A MULTIMODAL client for the live visual review, independent of the build/auth
 * backend: the screenshot judge needs vision, which the OpenRouter premium models
 * provide. Returns null (→ visual review skipped) when no OpenRouter creds exist.
 * Override the model with SER_VISUAL_MODEL.
 */
export async function makeVisualClient(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ llm: LlmClient; model: string } | null> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const { OpenRouterClient } = await import("./llm/openrouter.js");
  return {
    llm: new OpenRouterClient({ apiKey, baseUrl: env.OPENROUTER_BASE_URL }),
    model: env.SER_VISUAL_MODEL ?? "anthropic/claude-opus-4",
  };
}

/** The build-execution Engine for the configured backend (non-mock runs only). */
export async function makeBuildEngine(env: NodeJS.ProcessEnv = process.env): Promise<Engine> {
  if (backendName(env) === "codex") {
    const { CodexEngine } = await import("./engine/codex.js");
    return new CodexEngine();
  }
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new SquireError("NO_API_KEY", "OPENROUTER_API_KEY is required for a real run (use --mock otherwise)");
  const { PiEngine } = await import("./engine/pi.js");
  return new PiEngine();
}
