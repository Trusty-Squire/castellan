import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseSpec } from "../../src/contract/spec.js";
import type { LabeledSpecFixture, LabeledDefect } from "../../src/eval/review-eval.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = (name: string) => parseSpec(readFileSync(join(HERE, name), "utf8"), name);

const CLAIRVOYANCE = spec("clairvoyance.spec.yaml");
const CLEAN = spec("clean-dashboard.spec.yaml");

/** The DESIGN reviewer's four clairvoyance defects — the headline clairvoyance catch. */
const DESIGN_DEFECTS: LabeledDefect[] = [
  { tag: "size-not-displayed", keywords: ["size", "edge", "percentage", "displayed", "shown", "rendered", "visible"] },
  { tag: "ai-slop-bare-ui", keywords: ["bare", "unstyled", "slop", "plain background", "generic", "no hierarchy", "lacks hierarchy", "no visual"] },
  { tag: "no-empty-state", keywords: ["empty state", "empty"] },
  { tag: "trivial-fake-data", keywords: ["placeholder", "fake", "real data", "live data", "data source", "book name", "sample"] },
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
