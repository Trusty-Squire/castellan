/**
 * Built-in default chains so `ser talk`/`do`/`fix` run in ANY directory with
 * no chains.yaml authored. Same pinned slugs + per-million prices as the
 * repo's chains.yaml (verified live on OpenRouter, 2026-07). A project
 * chains.yaml or ~/.config/castellan/chains.yaml overrides this wholesale.
 * Kept as YAML text so it validates through the one parseChains code path.
 */
export const DEFAULT_CHAINS_YAML = `chains:
  cheap:
    executor: "qwen/qwen3-coder"
    fallback: "deepseek/deepseek-chat"
    knight: "z-ai/glm-5.2"
  knight-only:
    executor: "z-ai/glm-5.2"
    fallback: "z-ai/glm-5.2"
    knight: "z-ai/glm-5.2"
  cheap-raw:
    executor: "qwen/qwen3-coder"
    fallback: "qwen/qwen3-coder"
    knight: "qwen/qwen3-coder"
    harness: "off"
prices:
  "qwen/qwen3-coder": { in: 0.30, out: 1.00 }
  "deepseek/deepseek-chat": { in: 0.20, out: 0.80 }
  "z-ai/glm-5.2": { in: 0.93, out: 3.00 }
`;

/** Marker source label used when no chains file is found and defaults apply. */
export const BUILTIN_CHAINS_SOURCE = "<built-in defaults>";
