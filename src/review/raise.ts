import type { Audit } from "../contract/review.js";
import type { Spec } from "../contract/spec.js";
import type { VisualVerdict } from "./types.js";
import { polishFixes } from "./visual.js";

export interface OuterDeltaPlan {
  stories: string[];
  reasons: string[];
}

const TRACTABLE_BLOCKLIST =
  /\b(observability|runbook|slo|error budget|compliance|multi-region|on-call|ci pipeline|secret rotation|load testing|camera permissions?|ocr|real-time sky|astrology chart|birth chart)\b/i;
const USER_VISIBLE =
  /\b(first viewport|headline|primary|result|summary|reading|mode|selector|action|mobile|phone|touch|hierarchy|visible|scannable|tarot|tea|leaf|constellation|zodiac|cards?|symbols?|controls?|empty state|loading|ready|feedback)\b/i;
const TEST_ONLY = /\b(add|write|create).{0,96}\b(coverage|test|tests|spec|assertion)\b/i;
const TOOL_ARTIFACT =
  /\b(blank shell|empty shell|unrendered|apparently unrendered|screen is an empty shell|first viewport is blank|phone viewport is blank|mobile screenshot shows no|no visible content|no content, actions, or feedback|no title, mystical reading options, or start action|no reading choices or controls)\b/i;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isTractable(text: string): boolean {
  return text.trim().length > 0 && text.length <= 180 && !TRACTABLE_BLOCKLIST.test(text);
}

function isUserVisible(text: string): boolean {
  return USER_VISIBLE.test(text) && !TEST_ONLY.test(text);
}

export function isTestOnlyDelta(text: string): boolean {
  return TEST_ONLY.test(text);
}

function isLikelyToolArtifact(text: string): boolean {
  return TOOL_ARTIFACT.test(text);
}

function priority(text: string): number {
  const lower = text.toLowerCase();
  if (/\bduplicate|repeated|feature[- ]?grid|mode-summary grid\b/.test(lower)) return 3;
  if (/\b(result|summary|reading result|chosen input|fortune)\b/.test(lower)) return 0;
  if (/\b(first viewport|primary|hierarchy|mode|selector|action)\b/.test(lower)) return 1;
  if (/\bmobile|phone|touch\b/.test(lower)) return 2;
  return 3;
}

export interface DeltaCommitteeDecision {
  story: string;
  accepted: boolean;
  reason: string;
}

/**
 * Product, execution, and adversarial checks before a marginal outer-loop
 * change is allowed to mutate the spec. This stays deterministic so Codex-only
 * runs do not need another model call just to decide whether feedback is sane.
 */
export function reviewOuterDeltaCandidate(story: string, existingStories: string[] = []): DeltaCommitteeDecision {
  const trimmed = story.trim();
  const existing = new Set(existingStories.map(normalize));
  const key = normalize(trimmed);
  if (!key) return { story: trimmed, accepted: false, reason: "empty delta" };
  if (existing.has(key)) return { story: trimmed, accepted: false, reason: "duplicate of existing story" };
  if (!isTractable(trimmed)) return { story: trimmed, accepted: false, reason: "execution reviewer rejected it as too broad or infrastructure-heavy" };
  if (!isUserVisible(trimmed)) return { story: trimmed, accepted: false, reason: "product reviewer rejected it because it is not a user-visible product delta" };
  if (isLikelyToolArtifact(trimmed)) return { story: trimmed, accepted: false, reason: "adversarial reviewer rejected it as likely render/tool-artifact feedback" };
  return { story: trimmed, accepted: true, reason: "accepted by product, execution, and adversarial reviewers" };
}

export function reviewOuterDeltaBatch(stories: string[], existingStories: string[] = []): DeltaCommitteeDecision[] {
  const seen = new Set(existingStories.map(normalize));
  const out: DeltaCommitteeDecision[] = [];
  for (const story of stories) {
    const key = normalize(story);
    if (!key || seen.has(key)) {
      out.push({ story: story.trim(), accepted: false, reason: key ? "duplicate of existing story" : "empty delta" });
      continue;
    }
    const decision = reviewOuterDeltaCandidate(story, existingStories);
    out.push(decision);
    if (decision.accepted) seen.add(key);
  }
  return out;
}

export function planOuterDelta(
  spec: Pick<Spec, "stories">,
  audit: Audit["recommendations"],
  verdict: VisualVerdict,
  maxStories = 3,
): OuterDeltaPlan {
  const seen = new Set(spec.stories.map(normalize));
  const candidates: Array<{ story: string; reason: string }> = [];
  const pushCandidate = (story: string, reason: string): void => {
    const key = normalize(story);
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push({ story: story.trim(), reason });
  };

  for (const fix of polishFixes(verdict, 4)) pushCandidate(fix, "visual polish gap");

  for (const rec of audit.filter((r) => r.severity !== "low")) {
    pushCandidate(rec.note, `audit ${rec.lens} ${rec.severity}`);
  }

  const accepted = candidates
    .map((c) => ({ ...c, decision: reviewOuterDeltaCandidate(c.story, spec.stories) }))
    .filter((c) => c.decision.accepted)
    .sort((a, b) => priority(a.story) - priority(b.story));

  return {
    stories: accepted.slice(0, maxStories).map((c) => c.story),
    reasons: accepted.slice(0, maxStories).map((c) => `${c.reason}; ${c.decision.reason}`),
  };
}
