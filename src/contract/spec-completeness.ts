/**
 * SPEC COMPLETENESS — supply the product instinct a non-expert lacks, with CHEAP models only.
 *
 * The problem: a thin idea ("a URL shortener") omits the table-stakes features users expect but
 * never state (copy the link, custom alias, click stats, expiry, delete). The project already
 * found a cheap model is a poor single-shot ADVISOR (it can't tell load-bearing from cosmetic).
 * So we never ask one to JUDGE — two cheap stages instead:
 *   1. RECALL from several DIVERSE LENSES (security user, power user, first-timer, API dev, …).
 *      Divergence is the signal (the project's own ambiguity research): a feature every lens
 *      independently names is table-stakes; a feature one lens invents is noise.
 *   2. MERGE — one cheap pass collapses synonymous phrasings ("link expiration" / "set expiry"
 *      / "expiration settings" are ONE feature) and keeps only what ≥ quorum lenses agreed on.
 * Recall is the cheap model's strength; merging synonyms is mechanical, not load-bearing
 * judgment. Result: the funnel gains product instinct at ~half the cost of one Sonnet pass, with
 * no premium model — so "authoring = premium" stops being a required exception.
 */
import type { LlmClient } from "../llm/types.js";

/** Distinct user viewpoints. Each cheap call recalls essentials from one lens; only features that
 *  recur ACROSS lenses are table-stakes, not lens-specific. */
export const COMPLETENESS_LENSES = [
  "a security-conscious user",
  "a power user who manages many items daily",
  "a first-time, non-technical user",
  "someone migrating from a competing product",
  "a developer using the product's API",
  "a user on a phone",
];

const RECALL_SYSTEM =
  "You name the MUST-HAVE, table-stakes features a user expects from this KIND of product but that " +
  "are NOT already in the spec. Output ONLY a JSON array of short feature names — lowercase " +
  'verb-phrases, 2-5 words, e.g. ["copy the link","set a custom alias","see click counts","delete a link"]. ' +
  "Only genuinely-expected essentials for this product category. No nice-to-haves, no speculative extras.";

/**
 * Cheap-consensus completeness pass. Returns the missing table-stakes features, most-agreed first.
 * Pass a CHEAP model — recall across lenses + a merge pass, no premium judgment.
 */
export async function specCompleteness(
  llm: LlmClient,
  model: string,
  args: { idea: string; stated?: string[]; lenses?: string[]; quorum?: number },
): Promise<string[]> {
  const lenses = args.lenses ?? COMPLETENESS_LENSES;
  const stated = (args.stated ?? []).join("; ") || "(nothing yet)";

  // 1. RECALL from each diverse lens (independent cheap calls).
  const lists = await Promise.all(
    lenses.map((lens) =>
      llm
        .complete({
          model,
          system: RECALL_SYSTEM,
          user: `PRODUCT:\n${args.idea}\n\nALREADY IN THE SPEC (do NOT repeat these):\n${stated}\n\nThinking AS ${lens}, what ESSENTIAL features are missing?`,
          json: true,
          maxTokens: 400,
        })
        .then((r) => parseFeatures(r.text))
        .catch(() => []),
    ),
  );
  const pool = lists.filter((l) => l.length > 0);
  if (pool.length === 0) return [];

  const quorum = args.quorum ?? Math.max(2, Math.ceil(pool.length / 2));

  // 2. MERGE synonymous phrasings + keep only what ≥ quorum lenses agreed on (one cheap call).
  const mergeSystem =
    `You merge synonymous feature suggestions from ${pool.length} independent reviewers and report ONLY what they AGREE on. ` +
    `Output ONLY a JSON array of canonical feature names — short lowercase verb-phrases — that AT LEAST ${quorum} of the reviewers suggested. ` +
    `Treat differently-worded suggestions for the same capability as ONE (e.g. "link expiration", "set expiry date", and "expiration settings" are the SAME feature). ` +
    `Order by how many reviewers agreed, most-agreed first. No descriptions, no extras.`;
  const mergeUser = pool.map((l, i) => `Reviewer ${i + 1}: ${JSON.stringify(l)}`).join("\n");
  const merged = await llm
    .complete({ model, system: mergeSystem, user: mergeUser, json: true, maxTokens: 500 })
    .then((r) => parseFeatures(r.text))
    .catch(() => []);
  return merged;
}

/** Feature names from a model reply — tolerant of a JSON array of strings OR a JSON object
 *  ({feature_name: description}, which cheap models often return); object KEYS are humanized. */
export function parseFeatures(text: string): string[] {
  const arrM = text.match(/\[[\s\S]*\]/);
  if (arrM) {
    try {
      const arr: unknown = JSON.parse(arrM[0]);
      if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim());
    } catch { /* fall through to object */ }
  }
  const objM = text.match(/\{[\s\S]*\}/);
  if (objM) {
    try {
      const obj: unknown = JSON.parse(objM[0]);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return Object.keys(obj)
          .map((k) => k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase().trim())
          .filter(Boolean);
      }
    } catch { /* none */ }
  }
  return [];
}
