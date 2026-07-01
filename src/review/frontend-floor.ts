/**
 * Frontend floor heuristics: when the product is clearly a visual app/site/dashboard,
 * append a small set of UX floor stories so design review and visual review have
 * something concrete to enforce beyond "HTML exists".
 */

const VISUAL_APP_POSITIVE =
  /\b(web|website|site|page|dashboard|portal|admin|panel|app|ui|interface|table|list|feed|browser|viewport|visible)\b/i;
const VISUAL_APP_NEGATIVE =
  /\b(api|sdk|cli|command[- ]?line|terminal|stdout|library|package|framework|daemon|worker|service|mcp|connector)\b/i;

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

/**
 * The product's THESIS explicitly names a non-visual artifact (library, CLI, SDK,
 * package, framework, service…). Used to gate the visual review off the STABLE
 * thesis rather than the mutable stories — a rebuild can fold visual-fix stories
 * ("fix the cramped error rows / panel") into a library's spec, which would flip a
 * story-based check to "visual" and bogusly block a perfectly-good library on a
 * design review (the lib3 misfire). The thesis doesn't drift, so it's the reliable
 * signal for "this product has no UI to review."
 */
export function isExplicitlyNonVisual(thesis: string): boolean {
  return VISUAL_APP_NEGATIVE.test(thesis);
}

export function isVisualAppSpec(spec: StorySpecLike): boolean {
  if (isExplicitlyNonVisual(spec.thesis)) return false;
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

/** A spec with stories + tier-gated requirements (the full authored spec shape). */
interface GatedSpecLike extends StorySpecLike {
  requirements: { id: string; statement: string; acceptance: { tier: 0 | 1 | 2 | 3 | 4; gate?: string; artifact?: string } }[];
}

/**
 * A visual app needs a real product SURFACE, not just logic with passing unit tests
 * (the headless-library failure: every requirement is logic → the planner builds no
 * UI node → the audit correctly blocks "no application surface"). Inject ONE dense,
 * gated UI requirement so the planner is forced to build an actual UI node — index.html
 * wiring the logic into a usable app. The gate is the build floor (it must compile);
 * the LIVE VISUAL AUDIT carries the quality teeth. This is the deterministic, domain-
 * agnostic replacement for the deleted design reviewer's UI-requirement patch.
 */
export function withUiRequirement<T extends GatedSpecLike>(spec: T): T {
  if (!isVisualAppSpec(spec)) return spec;
  const hasUi = spec.requirements.some(
    (r) =>
      /\b(ui|index\.html|render|renders|viewport|screen|first screen|page|front[- ]?end|interface)\b/i.test(r.statement) ||
      /npm run build|vite build|index\.html/i.test(r.acceptance.gate ?? ""),
  );
  if (hasUi) return spec;
  const id = `R${spec.requirements.length + 1}`;
  const req = {
    id,
    statement:
      "The app renders a usable product UI in index.html, SEEDED WITH REALISTIC SAMPLE CONTENT on first load so the very first viewport shows the actual product in use — not an empty shell or a zero-state. The headline value is visible immediately, the primary workflow is operable end to end, the standard empty/loading/error states exist, and the layout is phone-friendly. Wire the domain logic into a real surface, not a headless library.",
    acceptance: { tier: 1 as const, gate: "npm run build --if-present" },
  };
  return { ...spec, requirements: [...spec.requirements, req] };
}
