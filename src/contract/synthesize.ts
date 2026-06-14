import { SpecSchema, type Spec } from "./spec.js";
import type { LlmClient } from "../llm/types.js";

/**
 * The SYNTHESIS pass (the structural fix for A41). ser-talk loses to a one-shot
 * because it assembles a spec through lossy incremental edits over disposable
 * history — it never reasons over the WHOLE at once, so it hedges, sprawls, and
 * emits subjective gates. This pass does what the one-shot does — a single
 * coherent pass that COMMITS, SCOPES to an MVP, and gives every requirement an
 * OBJECTIVE gate — but informed by the conversation's elicited facts, so the
 * result should BEAT a vanilla one-shot rather than tie it.
 */
export const SYNTHESIZE_PROMPT = `You are the SYNTHESIS pass. You are given a spec ELICITED through a conversation:
the user's thesis, the decisions/constraints THEY stated, and a draft set of
components. Produce the FINAL build spec in ONE coherent pass.

RULES:
- COMMIT. Pick specific technologies and choices; never offer a menu ("X or Y").
- SCOPE to a verifiable MVP. Cut every nice-to-have to v2; the smallest thing
  that delivers the core. A few sharp requirements beat many vague ones.
- EVERY requirement gets an OBJECTIVE gate: a single shell command a machine
  runs UNATTENDED (exit 0 = pass). The product is unattended loops, so a gate a
  human must eyeball is a failure. Reduce "subjective" to a command — latency
  assertion, persistence write/kill/relaunch/diff, feed-a-banned-phrase-assert-
  blocked, grep a rendered attribute. Only if a property is irreducibly
  subjective may "gate" be null (a human artifact); avoid it.
- PRESERVE every user-stated decision/constraint — NEVER contradict a fact the
  user gave (their platform, storage, audience, rules).

Output ONLY JSON:
{"thesis":"...","requirements":[{"statement":"...","gate":"shell command, or null"}],"decisions":[{"statement":"..."}]}`;

function parseJsonLoose(text: string): unknown {
  const cleaned = text.replace(/```json?/gi, "").replace(/```/g, "").trim();
  const s = cleaned.indexOf("{");
  const e = cleaned.lastIndexOf("}");
  if (s === -1 || e <= s) return null;
  try {
    return JSON.parse(cleaned.slice(s, e + 1));
  } catch {
    return null;
  }
}

interface SynthesisRaw {
  thesis?: string;
  requirements?: { statement?: string; gate?: string | null }[];
  decisions?: { statement?: string }[];
}

/** Lower-case significant-word overlap, for deduping decisions (0..1). */
function overlap(a: string, b: string): number {
  const w = (s: string): Set<string> => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 4));
  const x = w(a);
  const y = w(b);
  if (x.size === 0 || y.size === 0) return 0;
  let i = 0;
  for (const t of x) if (y.has(t)) i += 1;
  return i / Math.min(x.size, y.size);
}

/**
 * One holistic pass → a committed, MVP-scoped, objectively-gated spec. The
 * conversation's decisions are PRESERVED (unioned in) so no elicited fact is
 * lost; the synthesized requirements (with objective gates) replace the draft.
 * On any failure the input spec is returned unchanged (best-effort).
 */
export async function synthesizeSpec(spec: Spec, llm: LlmClient, model: string): Promise<Spec> {
  const elicited =
    `THESIS: ${spec.thesis}\n\n` +
    `USER DECISIONS/CONSTRAINTS (preserve these — never contradict):\n${spec.decisions.map((d) => `- ${d.statement}`).join("\n") || "(none)"}\n\n` +
    `DRAFT COMPONENTS:\n${spec.requirements.map((r) => `- ${r.statement}`).join("\n")}`;
  let res;
  try {
    res = await llm.complete({ model, system: SYNTHESIZE_PROMPT, user: elicited, json: true, maxTokens: 1500 });
  } catch {
    return spec;
  }
  const raw = parseJsonLoose(res.text) as SynthesisRaw | null;
  const reqs = (raw?.requirements ?? []).filter((r) => r.statement);
  if (reqs.length === 0) return spec;

  // Union elicited decisions with the synthesized ones (dedup by overlap) so the
  // synthesis can SHARPEN but never DROP a user-stated fact.
  const decisions = spec.decisions.map((d) => ({ id: d.id, statement: d.statement, rationale: d.rationale, claims: [] as string[] }));
  for (const d of raw?.decisions ?? []) {
    const s = d.statement?.trim();
    if (s && !decisions.some((e) => overlap(e.statement, s) >= 0.6)) {
      decisions.push({ id: `D${decisions.length + 1}`, statement: s, rationale: "synthesis", claims: [] });
    }
  }

  const obj = {
    thesis: raw?.thesis || spec.thesis,
    stories: spec.stories,
    scope_fence: spec.scope_fence,
    requirements: reqs.map((r, i) => ({
      id: `R${i + 1}`,
      statement: r.statement!,
      acceptance: r.gate ? { tier: 1 as const, gate: r.gate } : { tier: 0 as const },
    })),
    decisions: decisions.map((d, i) => ({ ...d, id: `D${i + 1}` })),
    claims: [],
    open_questions: [],
  };
  try {
    return SpecSchema.parse(obj);
  } catch {
    return spec;
  }
}
