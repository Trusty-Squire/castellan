/** Planner + any non-engine model calls go through this interface (SPEC §7). */
export interface LlmClient {
  complete(req: {
    model: string;
    system: string;
    user: string;
    json?: boolean;
    maxTokens: number;
    /**
     * Optional image inputs for multimodal review (the visual design judge sends
     * a screenshot of the built UI). Each is a data URL ("data:image/png;base64,…").
     * Clients that don't support vision MUST ignore this field (text-only call).
     */
    images?: { dataUrl: string }[];
  }): Promise<{
    text: string;
    inTokens: number;
    outTokens: number;
    /**
     * Actual USD billed for this call, when the provider reports it (A35/A36):
     * OpenRouter returns `usage.cost` when the request opts in. Absent when the
     * provider doesn't report it — callers fall back to price-table estimation.
     */
    costUsd?: number;
  }>;
}
