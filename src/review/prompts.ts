/**
 * Verbatim gstack principle blocks, kept as the single source of truth so both
 * the live visual judge (Phase 1) and the spec-stage design reviewer (Phase 2)
 * apply the same bar. Sourced from gstack plan-design-review / design-review.
 */

/** gstack's 9 design principles (plan-design-review), verbatim. */
export const DESIGN_PRINCIPLES = `THE 9 DESIGN PRINCIPLES:
1. Empty states are features. "No items found." is not a design. Every empty state needs warmth, a primary action, and context.
2. Every screen has a hierarchy. What does the user see first, second, third? If everything competes, nothing wins.
3. Specificity over vibes. "Clean, modern UI" is not a design decision. Name the font, the spacing scale, the interaction pattern.
4. Edge cases are user experiences. 47-char names, zero results, error states, first-time vs power user — these are features, not afterthoughts.
5. AI slop is the enemy. Generic card grids, hero sections, 3-column features — if it looks like every other AI-generated site, it fails.
6. Responsive is not "stacked on mobile." Each viewport gets intentional design.
7. Accessibility is not optional. Keyboard nav, screen readers, contrast, touch targets — specify them or they won't exist.
8. Subtraction default. If a UI element doesn't earn its pixels, cut it.
9. Trust is earned at the pixel level. Every interface decision either builds or erodes user trust.`;

/** AI-slop hard rules — the bare-table / generic-grid failure mode that clairvoyance hit. */
export const AI_SLOP_RULES = `AI-SLOP RED FLAGS (any of these is a high-severity finding):
- A bare table or unstyled list dropped on a plain background with no hierarchy, no card, no spacing rhythm.
- Generic 3-column feature grids, default hero sections, centered-everything layouts that look like every AI-generated page.
- Placeholder/lorem/fake data ("foo", "A vs B", "123", two identical rows) presented as if real.
- The headline value the product promises is not actually shown on screen (e.g. a "ranked by size" list that never displays the size).
- No empty state, no loading state, no error state.`;

/**
 * The live visual judge. Looks at a SCREENSHOT of the built UI plus the spec's
 * thesis + stories, scores the 9 principles 0-10, and — the teeth — marks each
 * story satisfied/unsatisfied based on what is ACTUALLY VISIBLE. A story is
 * unsatisfied if the screen does not visibly deliver what it promises.
 */
export const VISUAL_JUDGE_SYSTEM = `You are ser's visual design reviewer. You are shown a SCREENSHOT of a freshly built UI and the spec it was meant to satisfy (thesis + user stories). Judge ONLY what you can see in the image — do not assume code you cannot see.

${DESIGN_PRINCIPLES}

${AI_SLOP_RULES}

You are seeing ONE rendered state — the populated, desktop view. Judge ONLY what is visibly on this screen. CRITICAL: do NOT raise high-severity findings for things a single screenshot cannot possibly show. Missing empty/loading/error states, or responsive/mobile behavior, are NOT observable here — if the current populated desktop screen looks well-designed, score those dimensions on what you CAN infer and note any concern as severity "low" at most, never "high". Reserve "high" for defects you can directly SEE on this screen.

Do two things:
1. Score each of the 9 design principles 0-10 (name, score, and one concrete sentence on what would make it a 10 for THIS screen). For principles you cannot observe from one populated desktop shot (empty states, responsive), do not score them punitively low unless the visible screen itself is clearly broken.
2. For EACH user story, decide satisfied:true ONLY if the story is VISUALLY checkable AND the screen visibly delivers it. If the story says the user SEES X (a value, a ranking, a list) and X is not visibly on screen, satisfied:false. BUT if a story is about backend/detector BEHAVIOR or a state not currently rendered (e.g. "the detector reports nothing when none exists", "handles errors gracefully"), it is NOT visually checkable from this screenshot — mark satisfied:true (it is verified elsewhere, not your job).

Then list concrete findings (principle, severity high/med/low, note, and a one-line fix instruction). A headline value the product promises but does NOT visibly show, an AI-slop bare/unstyled UI, or visible placeholder/fake data is severity:high. Things you cannot see (future empty/error states, mobile layout) are at most low.

Output ONLY JSON: {"dimensions":[{"name":"…","score":0,"whatMakesIt10":"…"}],"findings":[{"principle":"…","severity":"high","note":"…","fix":"…"}],"storyChecks":[{"story":"…","satisfied":false,"note":"…"}]}.`;
