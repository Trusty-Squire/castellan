import { SquireError } from "../errors.js";
import type { LlmClient } from "./types.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

function retryableProviderRouteError(status: number, body: string): boolean {
  if (status === 429 || status >= 500) return true;
  if (status !== 400) return false;
  return /Provider returned error|temporarily rate-limited|rate[- ]limited upstream|thinking mode\s+is not supported/i.test(body);
}

/**
 * OpenRouter LlmClient: POST /chat/completions with OPENROUTER_API_KEY.
 * 2 retries with backoff on 429/5xx. Used only by the planner (derive);
 * the engine talks to providers through pi-ai.
 */
export class OpenRouterClient implements LlmClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: {
    apiKey: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async complete(req: {
    model: string;
    system: string;
    user: string;
    json?: boolean;
    maxTokens: number;
    signal?: AbortSignal;
    images?: { dataUrl: string }[];
  }): Promise<{ text: string; inTokens: number; outTokens: number; costUsd?: number }> {
    // With images, the user message becomes OpenAI-style multimodal content parts
    // (text + image_url); without, a plain string (unchanged wire format).
    const userContent = req.images && req.images.length > 0
      ? [
          { type: "text", text: req.user },
          ...req.images.map((img) => ({ type: "image_url", image_url: { url: img.dataUrl } })),
        ]
      : req.user;
    const body = {
      model: req.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: userContent },
      ],
      max_tokens: req.maxTokens,
      temperature: 0,
      // Ask OpenRouter to report ACTUAL billed cost in `usage.cost` (A36). Works
      // through the Trusty Squire egress grant (A35) — the proxy forwards the
      // usage block untouched — so the planner can surface real spend instead of
      // price-table arithmetic. Harmless on providers that ignore it.
      usage: { include: true },
      ...(req.json ? {
        response_format: { type: "json_object" },
        reasoning: { effort: "none", exclude: true },
      } : {}),
    };

    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await this.sleep(250 * 2 ** (attempt - 1));
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          signal: req.signal,
          body: JSON.stringify(body),
        });
      } catch (err) {
        lastErr = `network error: ${(err as Error).message}`;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (retryableProviderRouteError(res.status, text)) {
          lastErr = `OpenRouter HTTP ${res.status}: ${text.slice(0, 500)}`;
          continue;
        }
        throw new SquireError("LLM_HTTP", `OpenRouter HTTP ${res.status}: ${text.slice(0, 500)}`);
      }
      const json = (await res.json()) as {
        choices?: { finish_reason?: string; native_finish_reason?: string; message?: { content?: string; reasoning?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      const text = json.choices?.[0]?.message?.content ?? "";
      if (!text.trim()) {
        lastErr = `OpenRouter empty content (finish_reason=${json.choices?.[0]?.finish_reason ?? "unknown"})`;
        continue;
      }
      const reportedCost = json.usage?.cost;
      return {
        text,
        inTokens: json.usage?.prompt_tokens ?? 0,
        outTokens: json.usage?.completion_tokens ?? 0,
        // Only surface a finite, non-negative reported cost; otherwise leave
        // undefined so callers fall back to price-table estimation.
        ...(typeof reportedCost === "number" && Number.isFinite(reportedCost) && reportedCost >= 0
          ? { costUsd: reportedCost }
          : {}),
      };
    }
    throw new SquireError("LLM_RETRY", `OpenRouter failed after retries: ${lastErr}`);
  }
}
