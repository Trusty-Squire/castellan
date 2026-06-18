import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { LabeledVisualFixture } from "../../src/eval/visual-eval.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const build = (name: string): string => join(HERE, "builds", name);

const CLAIRVOYANCE_SPEC = {
  thesis:
    "a web dashboard that displays sports-betting lines and surfaces ranked cross-book trade (arbitrage) opportunities by size",
  stories: [
    "A user opens the dashboard and sees a table of current betting lines for several events across multiple books",
    "A user sees a list of trade opportunities (cross-book arbitrage) ranked by size, largest edge first",
    "The opportunity detector finds a real arbitrage when one exists and reports nothing when none exists",
  ],
};

/** Labeled visual fixtures: clairvoyance (defective) + a clean control. */
export const VISUAL_FIXTURES: LabeledVisualFixture[] = [
  {
    id: "clairvoyance",
    buildDir: build("clairvoyance"),
    spec: CLAIRVOYANCE_SPEC,
    isControl: false,
    defects: [
      { tag: "size-not-displayed", keywords: ["size", "edge", "percentage", "ranked", "ranking"] },
      { tag: "ai-slop-bare-ui", keywords: ["bare", "unstyled", "slop", "plain background", "hierarchy", "visual design"] },
      { tag: "no-empty-state", keywords: ["empty state", "empty"] },
      { tag: "trivial-fake-data", keywords: ["placeholder", "fake", "trivial", "book name", "which book", "sample"] },
    ],
  },
  {
    id: "clean-dashboard",
    buildDir: build("clean-dashboard"),
    spec: CLAIRVOYANCE_SPEC,
    isControl: true,
    defects: [],
  },
];
