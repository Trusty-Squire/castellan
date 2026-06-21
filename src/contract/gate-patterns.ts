import { SquireError } from "../errors.js";
import type { Gate } from "./schema.js";

/**
 * Gate-pattern library (SPEC-v0.2 §6.3). derive selects patterns instead of
 * free-writing shell commands; every pattern was born from a measured failure
 * (AUDIT.md / DOGFOOD.md), recorded in `bornFrom`. Rendering is pure: params
 * in, Gate out. Free-form gates remain possible but are flagged in readbacks.
 */

export interface GatePattern {
  id: string;
  description: string;
  /** The measured failure that motivated this pattern. */
  bornFrom: string;
  /** Required parameter names (validated at render). */
  params: string[];
  /** Optional parameter names. */
  optionalParams?: string[];
  render: (p: Record<string, string | string[]>) => Gate;
}

const str = (p: Record<string, string | string[]>, key: string): string => {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new SquireError("GATE_PATTERN_PARAM", `pattern param "${key}" must be a non-empty string`);
  }
  return v;
};

const list = (p: Record<string, string | string[]>, key: string): string[] => {
  const v = p[key];
  if (!Array.isArray(v) || v.length === 0) {
    throw new SquireError("GATE_PATTERN_PARAM", `pattern param "${key}" must be a non-empty list`);
  }
  return v;
};

const command = (run: string): Gate => ({ type: "command", run, soft: false });

export const GATE_PATTERNS: GatePattern[] = [
  {
    id: "tests-pass",
    description: "Run a test command; diff-guard listed files against tampering.",
    bornFrom: "AUDIT.md class 1 — a node passing by editing its own test",
    params: ["testCmd"],
    optionalParams: ["guardPaths"],
    render: (p) => {
      const guards = Array.isArray(p.guardPaths)
        ? p.guardPaths.map((g) => ` && git diff --quiet HEAD -- ${g}`).join("")
        : "";
      return command(`${str(p, "testCmd")}${guards}`);
    },
  },
  {
    id: "fail-for-the-right-reason",
    description:
      "Tests-first: the suite must FAIL, the failure must match the missing-impl signature, and must NOT contain fixture-crash markers.",
    bornFrom: "DOGFOOD.md run 1 — a broken fixture satisfied a naive 'suite fails' gate, poisoning the next node",
    params: ["testFile", "testCmd", "mustMatch"],
    optionalParams: ["mustNotMatch", "outFile"],
    render: (p) => {
      const out = typeof p.outFile === "string" && p.outFile ? p.outFile : "/tmp/castellan-gate-out.txt";
      const notMatch =
        typeof p.mustNotMatch === "string" && p.mustNotMatch
          ? ` && ! grep -q '${p.mustNotMatch}' ${out}`
          : " && ! grep -q ENOENT " + out;
      return command(
        `test -f ${str(p, "testFile")} && ! ${str(p, "testCmd")} > ${out} 2>&1 && grep -q '${str(p, "mustMatch")}' ${out}${notMatch}`,
      );
    },
  },
  {
    id: "varied-input",
    description: "node -e battery of >=2 varied input/output assertions so constants and branch hardcodes fail.",
    bornFrom: "AUDIT.md class 1 — hardcodeable single-input behavior gates (8 instances)",
    params: ["exprs"],
    render: (p) => {
      const exprs = list(p, "exprs");
      if (exprs.length < 2) {
        throw new SquireError("GATE_PATTERN_PARAM", "varied-input requires >=2 assertions (one is hardcodeable)");
      }
      return command(`node -e "process.exit((${exprs.join(") && (")}) ? 0 : 1)"`);
    },
  },
  {
    id: "mutation-guard",
    description: "A new test must pass against the real module AND fail against a planted mutant.",
    bornFrom: "AUDIT.md class 3 — vacuous tests passing while asserting nothing (5 instances)",
    params: ["module", "mutant", "testCmd", "grepToken", "testFile"],
    render: (p) =>
      command(
        `grep -q ${str(p, "grepToken")} ${str(p, "testFile")} && bash checks/mutation-guard.sh ${str(p, "module")} ${str(p, "mutant")} '${str(p, "testCmd")}'`,
      ),
  },
  {
    id: "completeness-grep",
    description: "Behavior check plus a NEGATIVE grep proving zero old-API/leftover call sites remain in scope.",
    bornFrom: "task 13/19 design — partial migrations passing on the visited subset",
    params: ["grepPattern", "scope"],
    optionalParams: ["behaviorCmd"],
    render: (p) => {
      const behavior = typeof p.behaviorCmd === "string" && p.behaviorCmd ? `${p.behaviorCmd} && ` : "";
      return command(`${behavior}! grep -rEn "${str(p, "grepPattern")}" ${str(p, "scope")}`);
    },
  },
  {
    id: "compile-gate",
    description: "Syntax/type check over every file in scope.",
    bornFrom: "task 08/13 — cross-file changes leaving unparseable files outside the tested path",
    params: ["scope"],
    optionalParams: ["checker"],
    render: (p) => {
      const checker = typeof p.checker === "string" && p.checker ? p.checker : "node --check";
      return command(`for f in $(find ${str(p, "scope")} -name '*.js' -o -name '*.ts'); do ${checker} "$f" || exit 1; done`);
    },
  },
  {
    id: "output-content-smoke",
    description: "Run the COMPILED artifact and assert on output CONTENT, not just exit code.",
    bornFrom: "DOGFOOD.md — fg.sync dead in dist while vitest passed; defensive warns masked it behind exit 0",
    params: ["runCmd", "mustMatch"],
    optionalParams: ["mustNotMatch"],
    render: (p) => {
      const not =
        typeof p.mustNotMatch === "string" && p.mustNotMatch ? ` && ! (${str(p, "runCmd")} | grep -q '${p.mustNotMatch}')` : "";
      return command(`${str(p, "runCmd")} | grep -q '${str(p, "mustMatch")}'${not}`);
    },
  },
  {
    id: "perf-threshold",
    description: "Benchmark script asserting correctness AND a wall/metric budget (tier 2).",
    bornFrom: "task 18 — correct-but-O(n^2) passing pure-correctness gates",
    params: ["benchCmd"],
    render: (p) => command(str(p, "benchCmd")),
  },
  {
    id: "metric-threshold",
    description: "Frozen perceptual/statistical metric behind a command (FID/LPIPS/etc., tier 2).",
    bornFrom: "SPEC-v0.2 §4 — subjective requirements anchored to references",
    params: ["metricCmd"],
    render: (p) => command(str(p, "metricCmd")),
  },
  {
    id: "human-adjudication",
    description: "Tier-4 checkpoint: pause on an adjudication artifact; verdict recorded; rejection drives the ladder.",
    bornFrom: "SPEC-v0.2 §4 — irreducibly subjective requirements (the chicken)",
    params: ["artifact"],
    render: (p) => ({ type: "human", artifact: str(p, "artifact"), soft: false }),
  },
  {
    id: "dom-behavior",
    description:
      "Drive the built page in a headless browser and assert a DOM BEHAVIOR a curl/grep can't see: " +
      'steps is a JSON array of {goto|wait|read(sel,as,prop?)|click(sel)|press(key)|assert(sel,<op>)}, ' +
      "where <op> is exists|count|gt|lt|changed|eq|includes|enabled|disabled|animated. Assert against STABLE " +
      "hooks the brief tells the builder to emit (#pot, [data-action=raise], [data-face]). Use for UI behaviors " +
      '(after clicking [data-action=raise] #pot increases; [data-face] flips on reveal), NOT for "looks good".',
    bornFrom: "the strip dogfood — the frontend node fell back to `grep poker-table` and a text page false-passed 'immersive'",
    params: ["url", "steps"],
    render: (p) => command(`ser dom-gate ${sq(str(p, "url"))} ${sq(str(p, "steps"))}`),
  },
  {
    id: "slop-audit",
    description:
      "Deterministic anti-AI-slop gate (no LLM, no browser): FAILS if the built CSS/HTML contains AI-design " +
      "tells (gradient-clipped text, glassmorphism blur, the cliche 667eea/764ba2 purple gradient). The taste " +
      "floor as RULES, not a VLM judge. params: scope (dir/path of built files). Extensible toward the full impeccable.style rule set.",
    bornFrom: "the taste residual — anti-slop is deterministic rules (impeccable.style: 44 rules, no LLM), not a flaky visual judge",
    params: ["scope"],
    render: (p) =>
      // grep finds a tell (exit 0) -> `!` flips to FAIL; no tell / no files -> PASS.
      command(`! grep -rIEl --include='*.css' --include='*.html' '${SLOP_TELLS}' ${str(p, "scope")}`),
  },
];

/** A starter set of high-signal AI-slop tells (POSIX ERE). Extend toward impeccable.style's 44. */
const SLOP_TELLS = "(-webkit-)?background-clip:[[:space:]]*text|backdrop-filter:[[:space:]]*blur|#?(667eea|764ba2)";

/** Single-quote a shell argument (the steps JSON travels intact to `ser dom-gate`). */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const byId = new Map(GATE_PATTERNS.map((g) => [g.id, g]));

export function getPattern(id: string): GatePattern {
  const p = byId.get(id);
  if (!p) {
    throw new SquireError(
      "GATE_PATTERN_UNKNOWN",
      `unknown gate pattern "${id}" (known: ${GATE_PATTERNS.map((g) => g.id).join(", ")})`,
    );
  }
  return p;
}

/** Render a pattern into a Gate, validating required params. */
export function renderGate(id: string, params: Record<string, string | string[]>): Gate {
  const pattern = getPattern(id);
  for (const required of pattern.params) {
    if (!(required in params)) {
      throw new SquireError("GATE_PATTERN_PARAM", `pattern "${id}" missing required param "${required}"`);
    }
  }
  return pattern.render(params);
}
