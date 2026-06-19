import { describe, expect, it } from "vitest";
import { backendFor, backendName, makeBuildEngine, makeLlmClient, makeVisualClient } from "../src/backend.js";

describe("backend selection", () => {
  it("uses SER_BACKEND as the default for every role", () => {
    const env = { SER_BACKEND: "codex" } as NodeJS.ProcessEnv;
    expect(backendName(env)).toBe("codex");
    expect(backendFor("llm", env)).toBe("codex");
    expect(backendFor("build", env)).toBe("codex");
    expect(backendFor("visual", env)).toBe("codex");
  });

  it("allows per-role overrides", () => {
    const env = {
      SER_BACKEND: "codex",
      SER_LLM_BACKEND: "openrouter",
      SER_BUILD_BACKEND: "codex",
      SER_VISUAL_BACKEND: "openrouter",
    } as NodeJS.ProcessEnv;
    expect(backendFor("llm", env)).toBe("openrouter");
    expect(backendFor("build", env)).toBe("codex");
    expect(backendFor("visual", env)).toBe("openrouter");
  });
});

describe("backend adapters", () => {
  it("creates a Codex llm + visual client when those roles are set to codex", async () => {
    const env = { SER_BACKEND: "codex" } as NodeJS.ProcessEnv;
    const llm = await makeLlmClient(env);
    const visual = await makeVisualClient(env);
    expect(llm.constructor.name).toBe("CodexCliClient");
    expect(visual?.llm.constructor.name).toBe("CodexCliClient");
  });

  it("creates OpenRouter-backed llm + visual clients when those roles are set to openrouter", async () => {
    const env = {
      SER_BACKEND: "openrouter",
      OPENROUTER_API_KEY: "k",
    } as NodeJS.ProcessEnv;
    const llm = await makeLlmClient(env);
    const visual = await makeVisualClient(env);
    expect(llm.constructor.name).toBe("OpenRouterClient");
    expect(visual?.llm.constructor.name).toBe("OpenRouterClient");
  });

  it("creates the matching build engine for each role", async () => {
    const codex = await makeBuildEngine({ SER_BUILD_BACKEND: "codex" } as NodeJS.ProcessEnv);
    const openrouter = await makeBuildEngine({
      SER_BUILD_BACKEND: "openrouter",
      OPENROUTER_API_KEY: "k",
    } as NodeJS.ProcessEnv);
    expect(codex.constructor.name).toBe("CodexEngine");
    expect(openrouter.constructor.name).toBe("PiEngine");
  });
});
