import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseSpec } from "../../src/contract/spec.js";
import type { ReviewSpecInput, ReviewerName } from "../../src/review/reviewers.js";

/** A labeled defect: a tag + the keywords that signal a reviewer caught it. */
export interface LabeledDefect {
  tag: string;
  keywords: string[];
}
/** A labeled spec fixture for the gate-strength eval (formerly shared with the
 *  deleted review-eval). Defects a reviewer SHOULD catch; probes a clean impl
 *  must NOT trigger; isControl flips any probe match into a false positive. */
export interface LabeledSpecFixture {
  id: string;
  spec: ReviewSpecInput;
  reviewer: ReviewerName;
  isControl: boolean;
  defects: LabeledDefect[];
  probes: LabeledDefect[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = (name: string) => parseSpec(readFileSync(join(HERE, name), "utf8"), name);

const CLAIRVOYANCE = spec("clairvoyance.spec.yaml");
const CLEAN = spec("clean-dashboard.spec.yaml");

/** The DESIGN reviewer's four clairvoyance defects — the headline clairvoyance catch. */
const DESIGN_DEFECTS: LabeledDefect[] = [
  { tag: "size-not-displayed", keywords: ["size", "edge", "percentage", "headline value", "prominent", "largest first", "sorted by"] },
  { tag: "ai-slop-bare-ui", keywords: ["bare", "unstyled", "slop", "hierarchy", "plain background", "generic", "specificity", "no visual"] },
  { tag: "no-empty-state", keywords: ["empty state", "empty"] },
  // the design symptoms of trivial/fake lines: real lines name the book, show the
  // odds, and carry a freshness signal; "A vs B, 2.0/2.0" placeholder data has none.
  { tag: "trivial-fake-data", keywords: ["book", "sportsbook", "odds", "freshness", "timestamp", "placeholder", "fake", "real data", "data source", "hardcoded", "mock", "sample"] },
];

const CEO_DEFECTS: LabeledDefect[] = [
  // detector "reports nothing" is ambiguous with an error — a silent failure the user can't tell apart.
  { tag: "silent-detector-failure", keywords: ["silent", "error", "fail", "distinguish", "no edge", "visible"] },
  { tag: "no-named-data-source", keywords: ["data source", "real data", "feed", "where", "api", "live"] },
];

const ENG_DEFECTS: LabeledDefect[] = [
  { tag: "no-correctness-test", keywords: ["test", "correct", "verify", "assert", "edge case"] },
  { tag: "no-error-path", keywords: ["error", "fail", "exception", "fetch", "nil", "empty", "handle"] },
];

/**
 * One entry per (fixture, reviewer). Controls carry the same defect groups as
 * PROBES — a clean spec that already specifies size/empty-state/real-data should
 * NOT trip them, so any match on a control is a false positive. dx self-skips on
 * this non-developer-facing product (no defects, no probes → vacuously clean).
 */
export const SPEC_FIXTURES: LabeledSpecFixture[] = [
  { id: "clairvoyance/design", spec: CLAIRVOYANCE, reviewer: "design", isControl: false, defects: DESIGN_DEFECTS, probes: [] },
  { id: "clairvoyance/ceo", spec: CLAIRVOYANCE, reviewer: "ceo", isControl: false, defects: CEO_DEFECTS, probes: [] },
  { id: "clairvoyance/eng", spec: CLAIRVOYANCE, reviewer: "eng", isControl: false, defects: ENG_DEFECTS, probes: [] },
  { id: "clairvoyance/dx", spec: CLAIRVOYANCE, reviewer: "dx", isControl: false, defects: [], probes: [] },

  { id: "clean/design", spec: CLEAN, reviewer: "design", isControl: true, defects: [], probes: DESIGN_DEFECTS },
  { id: "clean/ceo", spec: CLEAN, reviewer: "ceo", isControl: true, defects: [], probes: CEO_DEFECTS },
  { id: "clean/eng", spec: CLEAN, reviewer: "eng", isControl: true, defects: [], probes: ENG_DEFECTS },
  { id: "clean/dx", spec: CLEAN, reviewer: "dx", isControl: true, defects: [], probes: [] },
];
