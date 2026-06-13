import type { LlmClient } from "./types.js";

export interface MockLlmResponse {
  text: string;
  inTokens?: number;
  outTokens?: number;
  /** Provider-reported actual cost for this call (A36). Omit to simulate a
   *  provider that doesn't report cost (callers fall back to estimation). */
  costUsd?: number;
}

type Responder = MockLlmResponse | ((call: {
  model: string;
  system: string;
  user: string;
}) => MockLlmResponse);

/** Scripted LlmClient for tests — returns responses in order, recording calls. */
export class MockLlm implements LlmClient {
  private readonly responders: Responder[];
  private index = 0;
  readonly calls: { model: string; system: string; user: string; json?: boolean }[] = [];

  constructor(responders: Responder[]) {
    this.responders = responders;
  }

  async complete(req: {
    model: string;
    system: string;
    user: string;
    json?: boolean;
    maxTokens: number;
  }): Promise<{ text: string; inTokens: number; outTokens: number; costUsd?: number }> {
    this.calls.push({ model: req.model, system: req.system, user: req.user, json: req.json });
    const responder = this.responders[Math.min(this.index, this.responders.length - 1)];
    this.index += 1;
    if (responder === undefined) {
      throw new Error("MockLlm: no scripted response");
    }
    const r = typeof responder === "function" ? responder(req) : responder;
    return {
      text: r.text,
      inTokens: r.inTokens ?? 100,
      outTokens: r.outTokens ?? 200,
      ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
    };
  }
}
