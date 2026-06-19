/**
 * Frontend floor heuristics: when the product is clearly a visual app/site/dashboard,
 * append a small set of UX floor stories so design review and visual review have
 * something concrete to enforce beyond "HTML exists".
 */

const VISUAL_APP_POSITIVE =
  /\b(web|website|site|page|dashboard|portal|admin|panel|app|ui|interface|table|list|feed)\b/i;
const VISUAL_APP_NEGATIVE =
  /\b(api|sdk|cli|library|package|framework|daemon|worker|service|mcp|connector)\b/i;

export const FRONTEND_FLOOR_STORIES = [
  "A user sees the product's headline value in the first viewport rather than a generic shell.",
  "A user can scan the primary content and compare key values without reading long prose.",
  "A user can see the key value or ranking the product promises, not just labels or surrounding chrome.",
  "A user on a phone-sized viewport can still use the primary workflow without broken layout or horizontal scrolling.",
];

export interface StorySpecLike {
  thesis: string;
  stories: string[];
}

export function isVisualAppSpec(spec: StorySpecLike): boolean {
  const hay = [spec.thesis, ...spec.stories].join("\n");
  if (VISUAL_APP_POSITIVE.test(hay)) return true;
  return /\b(show|display|render|see|screen|viewport|layout|mobile)\b/i.test(hay) && !VISUAL_APP_NEGATIVE.test(hay);
}

function normStory(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function withFrontendFloorStories<T extends StorySpecLike>(spec: T): T {
  if (!isVisualAppSpec(spec)) return spec;
  const seen = new Set(spec.stories.map(normStory));
  const stories = [...spec.stories];
  for (const s of FRONTEND_FLOOR_STORIES) {
    const key = normStory(s);
    if (seen.has(key)) continue;
    seen.add(key);
    stories.push(s);
  }
  return { ...spec, stories };
}
