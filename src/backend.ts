/**
 * Backend selection for each phase. `SER_BACKEND` is the default for all phases,
 * and `SER_LLM_BACKEND` / `SER_BUILD_BACKEND` / `SER_VISUAL_BACKEND` can
 * override it independently so adapters stay plug-and-play.
 */
import type { LlmClient } from "./llm/types.js";
import type { Engine } from "./engine/types.js";
import { SquireError } from "./errors.js";

export type BackendName = "openrouter" | "codex";
export type BackendRole = "llm" | "build" | "visual";

export function backendName(env: NodeJS.ProcessEnv = process.env): BackendName {
  return env.SER_BACKEND === "codex" ? "codex" : "openrouter";
}

export function backendFor(role: BackendRole, env: NodeJS.ProcessEnv = process.env): BackendName {
  const key = role === "llm" ? env.SER_LLM_BACKEND : role === "build" ? env.SER_BUILD_BACKEND : env.SER_VISUAL_BACKEND;
  return key === "codex" ? "codex" : key === "openrouter" ? "openrouter" : backendName(env);
}

/** The planning/authoring LlmClient for the configured backend. */
export async function makeLlmClient(env: NodeJS.ProcessEnv = process.env): Promise<LlmClient> {
  if (backendFor("llm", env) === "codex") {
    const { CodexCliClient } = await import("./llm/codex-cli.js");
    return new CodexCliClient();
  }
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new SquireError("NO_API_KEY", "OPENROUTER_API_KEY required (or set SER_BACKEND=codex)");
  const { OpenRouterClient } = await import("./llm/openrouter.js");
  return new OpenRouterClient({ apiKey, baseUrl: env.OPENROUTER_BASE_URL });
}

/**
 * A visual-review client for screenshot judging. The visual phase can use a
 * different adapter than planning/build, but it is selected explicitly.
 */
export async function makeVisualClient(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ llm: LlmClient; model: string } | null> {
  if (backendFor("visual", env) === "codex") {
    const { CodexCliClient } = await import("./llm/codex-cli.js");
    return { llm: new CodexCliClient(), model: env.CODEX_MODEL ?? "codex" };
  }
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const { OpenRouterClient } = await import("./llm/openrouter.js");
  return { llm: new OpenRouterClient({ apiKey, baseUrl: env.OPENROUTER_BASE_URL }), model: env.SER_VISUAL_MODEL ?? "anthropic/claude-opus-4" };
}

/** The build-execution Engine for the configured backend (non-mock runs only). */
export async function makeBuildEngine(env: NodeJS.ProcessEnv = process.env): Promise<Engine> {
  if (backendFor("build", env) === "codex") {
    const { CodexEngine } = await import("./engine/codex.js");
    return new CodexEngine();
  }
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new SquireError("NO_API_KEY", "OPENROUTER_API_KEY is required for a real run (use --mock otherwise)");
  const { PiEngine } = await import("./engine/pi.js");
  return new PiEngine();
}
