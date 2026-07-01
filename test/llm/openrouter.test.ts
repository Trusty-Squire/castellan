import { describe, it, expect } from "vitest";
import { OpenRouterClient } from "../../src/llm/openrouter.js";
import { SquireError } from "../../src/errors.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const okBody = {
  choices: [{ message: { content: '{"nodes":[]}' } }],
  usage: { prompt_tokens: 42, completion_tokens: 7 },
};

describe("OpenRouterClient", () => {
  it("posts and parses content + usage", async () => {
    let captured: RequestInit | undefined;
    const client = new OpenRouterClient({
      apiKey: "k",
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        captured = init;
        return jsonResponse(okBody);
      }) as unknown as typeof fetch,
    });
    const r = await client.complete({ model: "m", system: "s", user: "u", json: true, maxTokens: 100 });
    expect(r.text).toBe('{"nodes":[]}');
    expect(r.inTokens).toBe(42);
    expect(r.outTokens).toBe(7);
    const body = JSON.parse(String(captured!.body));
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.reasoning).toEqual({ effort: "none", exclude: true });
    expect(body.model).toBe("m");
    // opts into provider-reported cost (A36)
    expect(body.usage).toEqual({ include: true });
  });

  it("surfaces provider-reported cost (usage.cost) as costUsd", async () => {
    const client = new OpenRouterClient({
      apiKey: "k",
      fetchImpl: (async () =>
        jsonResponse({
          choices: [{ message: { content: "{}" } }],
          usage: { prompt_tokens: 8, completion_tokens: 5, cost: 0.0000042 },
        })) as unknown as typeof fetch,
    });
    const r = await client.complete({ model: "m", system: "s", user: "u", maxTokens: 100 });
    expect(r.costUsd).toBe(0.0000042);
  });

  it("leaves costUsd undefined when the provider reports no cost", async () => {
    const client = new OpenRouterClient({
      apiKey: "k",
      fetchImpl: (async () => jsonResponse(okBody)) as unknown as typeof fetch,
    });
    const r = await client.complete({ model: "m", system: "s", user: "u", maxTokens: 100 });
    expect(r.costUsd).toBeUndefined();
  });

  it("ignores a non-finite or negative reported cost", async () => {
    const client = new OpenRouterClient({
      apiKey: "k",
      fetchImpl: (async () =>
        jsonResponse({
          choices: [{ message: { content: "{}" } }],
          usage: { prompt_tokens: 8, completion_tokens: 5, cost: -1 },
        })) as unknown as typeof fetch,
    });
    const r = await client.complete({ model: "m", system: "s", user: "u", maxTokens: 100 });
    expect(r.costUsd).toBeUndefined();
  });

  it("retries on 5xx then succeeds", async () => {
    let calls = 0;
    const client = new OpenRouterClient({
      apiKey: "k",
      sleep: async () => {},
      fetchImpl: (async () => {
        calls += 1;
        return calls < 2 ? jsonResponse({}, 503) : jsonResponse(okBody);
      }) as unknown as typeof fetch,
    });
    const r = await client.complete({ model: "m", system: "s", user: "u", maxTokens: 100 });
    expect(calls).toBe(2);
    expect(r.inTokens).toBe(42);
  });

  it("throws after exhausting retries", async () => {
    const client = new OpenRouterClient({
      apiKey: "k",
      sleep: async () => {},
      fetchImpl: (async () => jsonResponse({}, 500)) as unknown as typeof fetch,
    });
    await expect(client.complete({ model: "m", system: "s", user: "u", maxTokens: 100 })).rejects.toThrow(
      SquireError,
    );
  });

  it("throws immediately on a 4xx (non-429)", async () => {
    const client = new OpenRouterClient({
      apiKey: "k",
      sleep: async () => {},
      fetchImpl: (async () => jsonResponse({ error: "bad" }, 400)) as unknown as typeof fetch,
    });
    await expect(client.complete({ model: "m", system: "s", user: "u", maxTokens: 100 })).rejects.toThrow(
      /HTTP 400/,
    );
  });

  it("retries OpenRouter provider-route 400s then succeeds", async () => {
    let calls = 0;
    const client = new OpenRouterClient({
      apiKey: "k",
      sleep: async () => {},
      fetchImpl: (async () => {
        calls += 1;
        return calls < 2
          ? jsonResponse({
              error: {
                message: "Provider returned error",
                metadata: {
                  raw: "{\"message\":\"thinking mode  is not supported\"}",
                  previous_errors: [{ code: 429, raw: "temporarily rate-limited upstream" }],
                },
              },
            }, 400)
          : jsonResponse(okBody);
      }) as unknown as typeof fetch,
    });

    const r = await client.complete({ model: "m", system: "s", user: "u", maxTokens: 100 });
    expect(calls).toBe(2);
    expect(r.text).toBe('{"nodes":[]}');
  });

  it("retries empty content responses then succeeds", async () => {
    let calls = 0;
    const client = new OpenRouterClient({
      apiKey: "k",
      sleep: async () => {},
      fetchImpl: (async () => {
        calls += 1;
        return calls < 2
          ? jsonResponse({
              choices: [{ finish_reason: "length", message: { content: "", reasoning: "thinking without final JSON" } }],
              usage: { prompt_tokens: 8, completion_tokens: 4000 },
            })
          : jsonResponse(okBody);
      }) as unknown as typeof fetch,
    });

    const r = await client.complete({ model: "m", system: "s", user: "u", maxTokens: 100 });
    expect(calls).toBe(2);
    expect(r.text).toBe('{"nodes":[]}');
  });
});
