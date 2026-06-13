/** Planner + any non-engine model calls go through this interface (SPEC §7). */
export interface LlmClient {
  complete(req: {
    model: string;
    system: string;
    user: string;
    json?: boolean;
    maxTokens: number;
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
