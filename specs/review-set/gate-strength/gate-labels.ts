import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { UxGateCase } from "../../../src/eval/gate-strength.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = (...p: string[]): string => join(HERE, ...p);

/**
 * One UX gate per row, each with a complete impl (gate must PASS) and an
 * incomplete impl carrying the defect (gate must FAIL). These operationalize the
 * design reviewer's objective patches — the size/empty-state/real-data gates that
 * clairvoyance's structure-presence gate ("an <li> exists") failed to enforce.
 */
export const UX_GATE_CASES: UxGateCase[] = [
  {
    tag: "size-displayed",
    gate: "grep -qE 'data-(edge|size)' index.html",
    completeDir: dir("dashboard", "complete"),
    incompleteDir: dir("dashboard", "incomplete"),
  },
  {
    tag: "empty-state",
    gate: "grep -qi 'no opportunities' index.html",
    completeDir: dir("dashboard", "complete"),
    incompleteDir: dir("dashboard", "incomplete"),
  },
  {
    tag: "real-data-source",
    gate: "grep -q 'the-odds-api' src/feed.js",
    completeDir: dir("feed", "complete"),
    incompleteDir: dir("feed", "incomplete"),
  },
];
