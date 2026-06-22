/**
 * SPEC COMPLETENESS — supply the product instinct a non-expert lacks, with CHEAP models only.
 *
 * The problem: a thin idea ("a credential vault") omits the table-stakes features the user
 * expects but never states (reveal a key, copy it, delete one). The project already found a
 * cheap model is a poor single-shot ADVISOR (it can't tell load-bearing from cosmetic). So we
 * never ask it to JUDGE — we ask it to RECALL, from several DIVERSE LENSES, then keep only what
 * a majority of lenses INDEPENDENTLY name. Consensus over diverse cheap samples amplifies the
 * genuinely-canonical features and drowns out per-lens fluff (self-consistency), and divergence
 * is the signal (the project's own ambiguity research) — a feature one lens invents is noise; a
 * feature every lens names is real. This turns a JUDGMENT task (cheap models' weakness) into a
 * RECALL + COUNT task (their strength × aggregation), at ~half the cost of one Sonnet pass.
 */
import type { LlmClient } from "../llm/types.js";

/** Distinct user viewpoints — each cheap call recalls essentials from one lens. Divergence is
 *  the point: only features that recur ACROSS lenses are table-stakes, not lens-specific. */
export const COMPLETENESS_LENSES = [
  "a security-conscious user",
  "a power user who manages many items daily",
  "a first-time, non-technical user",
  "someone migrating from a competing product",
  "a developer using the product's API",
  "a user on a phone",
];

const SYSTEM =
  "You name the MUST-HAVE, table-stakes features a user expects from this KIND of product but that " +
  "are NOT already in the spec. Output ONLY a JSON array of short feature names — lowercase " +
  'verb-phrases, 2-5 words, e.g. ["copy value to clipboard","reveal a masked value","delete an item"]. ' +
  "Only genuinely-expected essentials for this product category. No nice-to-haves, no speculative extras.";

export interface CompletenessResult {
  feature: string; // a representative phrasing
  votes: number; // how many lenses named it
}

/**
 * Run the cheap-consensus completeness pass. Returns the missing table-stakes features that
 * ≥ quorum lenses independently named, most-agreed first. Pass a CHEAP model.
 */
export async function specCompleteness(
  llm: LlmClient,
  model: string,
  args: { idea: string; stated?: string[]; lenses?: string[]; quorum?: number },
): Promise<CompletenessResult[]> {
  const lenses = args.lenses ?? COMPLETENESS_LENSES;
  const quorum = args.quorum ?? Math.ceil(lenses.length / 2);
  const stated = (args.stated ?? []).join("; ") || "(nothing yet)";

  const samples = await Promise.all(
    lenses.map((lens) =>
      llm
        .complete({
          model,
          system: SYSTEM,
          user: `PRODUCT:\n${args.idea}\n\nALREADY IN THE SPEC (do NOT repeat these):\n${stated}\n\nThinking AS ${lens}, what ESSENTIAL features are missing?`,
          json: true,
          maxTokens: 400,
        })
        .then((r) => r.text)
        .catch(() => "[]"),
    ),
  );

  // Tally with light clustering: phrasings that reduce to the same signature are one feature.
  const tally = new Map<string, { canonical: string; votes: number }>();
  for (const text of samples) {
    const seen = new Set<string>(); // dedup WITHIN a lens so one lens = at most one vote per feature
    for (const raw of parseFeatures(text)) {
      const sig = signature(raw);
      if (!sig || seen.has(sig)) continue;
      seen.add(sig);
      const e = tally.get(sig) ?? { canonical: raw, votes: 0 };
      e.votes += 1;
      tally.set(sig, e);
    }
  }
  return [...tally.values()]
    .filter((e) => e.votes >= quorum)
    .sort((a, b) => b.votes - a.votes)
    .map((e) => ({ feature: e.canonical, votes: e.votes }));
}

/** Pull a JSON array of feature strings out of a model reply (tolerant of fences / extra prose). */
export function parseFeatures(text: string): string[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr: unknown = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim());
  } catch {
    return [];
  }
}

// Common UI-verb synonyms collapse to one token so "reveal"/"show"/"unmask" cluster together.
const VERB_CANON: Record<string, string> = {
  show: "reveal", unmask: "reveal", unhide: "reveal", view: "reveal", display: "reveal",
  remove: "delete", revoke: "delete", erase: "delete",
  create: "add", new: "add", store: "add",
  update: "edit", modify: "edit", rename: "edit",
  find: "search", filter: "search", lookup: "search",
  clipboard: "copy",
};
// Words that carry no distinguishing meaning for a feature (articles, fillers, generic nouns).
const STOP = new Set([
  "a", "an", "the", "to", "of", "for", "with", "and", "or", "your", "my", "this", "that", "into",
  "able", "ability", "allow", "support", "can", "be", "is", "it", "on", "in", "from", "as", "per",
  "user", "users", "item", "items", "entry", "entries", "value", "values", "data", "key", "keys",
  "credential", "credentials", "api", "page", "feature", "option", "secret", "secrets", "field",
]);

/** Reduce a feature phrase to a content-word signature so near-phrasings cluster as one. */
export function signature(raw: string): string {
  const words = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .map((w) => VERB_CANON[w] ?? w)
    .filter((w) => w && !STOP.has(w));
  return [...new Set(words)].sort().join(" ");
}
