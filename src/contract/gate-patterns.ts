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
  render: (p: Record<string, unknown>) => Gate;
}

const str = (p: Record<string, unknown>, key: string): string => {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new SquireError("GATE_PATTERN_PARAM", `pattern param "${key}" must be a non-empty string`);
  }
  return v;
};

const list = (p: Record<string, unknown>, key: string): string[] => {
  const v = p[key];
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string")) {
    throw new SquireError("GATE_PATTERN_PARAM", `pattern param "${key}" must be a non-empty list of strings`);
  }
  return v as string[];
};

/** dom-behavior steps may arrive as a native JSON array (preferred — the cheap model
 *  emits it directly) OR a JSON string. Return the JSON string the runner consumes. */
const stepsArg = (p: Record<string, unknown>, key: string): string => {
  const v = p[key];
  if (typeof v === "string" && v.length > 0) return v;
  if (Array.isArray(v) && v.length > 0) return JSON.stringify(v);
  throw new SquireError("GATE_PATTERN_PARAM", `pattern param "${key}" must be a non-empty steps array (or JSON string)`);
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
    optionalParams: ["mustNotMatch", "outFile", "exercises"],
    render: (p) => {
      const out = typeof p.outFile === "string" && p.outFile ? p.outFile : "/tmp/castellan-gate-out.txt";
      // grep -qE: mustMatch/mustNotMatch are REGEX alternations ("AssertionError|expected|FAIL").
      // Without -E, grep treats `|` as a literal pipe → the pattern never matches → the repro gate
      // is unsatisfiable by any repro (latent bug surfaced by the SWE-bench spike).
      const notMatch =
        typeof p.mustNotMatch === "string" && p.mustNotMatch
          ? ` && ! grep -qE '${p.mustNotMatch}' ${out}`
          : " && ! grep -qE ENOENT " + out;
      // EXERCISES: the repro must actually IMPORT and USE the module under test — else a vacuous
      // `self.fail("...")` / `assert False` that touches no real code satisfies the "it fails" check
      // yet can NEVER be made to pass, dooming the fix node (SWE-bench: a fake proxy-407 self.fail
      // repro halted a node before the model ever fixed anything). Require an import of the module
      // AND a second reference to it, so the test calls into the code it claims to reproduce.
      const tf = str(p, "testFile");
      const exercises =
        typeof p.exercises === "string" && p.exercises
          ? ` && grep -qE '(import +${p.exercises}|from +${p.exercises}( |\\.|import))' ${tf} && [ "$(grep -cE '\\b${p.exercises}\\b' ${tf})" -ge 2 ]`
          : "";
      return command(
        `test -f ${tf} && ! ${str(p, "testCmd")} > ${out} 2>&1 && grep -qE '${str(p, "mustMatch")}' ${out}${notMatch}${exercises}`,
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
      "Drive the built page in a headless browser and assert a DOM BEHAVIOR a curl/grep can't see. " +
      'params: url; steps (a JSON ARRAY of {goto|wait|read(sel,as,prop?)|click(sel)|press(key)|assert(sel,<op>)} ' +
      "where <op> is exists|count|gt|lt|changed|eq|includes|enabled|disabled|animated); and OPTIONAL serve (a shell " +
      "command that boots the app on url, e.g. \"npm start\" — the runner waits for url then drives, then kills it). " +
      "Assert against the STABLE hooks the contract pins ([data-testid=pot], [data-action=raise], [data-card]). " +
      'Example params: {"url":"http://localhost:3000","serve":"npm start","steps":[{"read":"[data-testid=pot]","as":"p0"},' +
      '{"click":"[data-action=raise]"},{"assert":"[data-testid=pot]","gt":"p0"}]}. Use for UI behaviors, NOT for "looks good".',
    bornFrom: "the strip dogfood — the frontend node fell back to `grep poker-table` and a text page false-passed 'immersive'",
    params: ["url", "steps"],
    optionalParams: ["serve"],
    // The runner is scaffolded into .squire/ (git-clean-excluded) by the harness, so the
    // gate runs with bare `node` — no `ser` on PATH, no deps in the build env.
    render: (p) => {
      const serve = typeof p.serve === "string" && p.serve.length > 0 ? ` --serve ${sq(p.serve)}` : "";
      return command(`node .squire/dom-gate.mjs ${sq(str(p, "url"))} ${sq(stepsArg(p, "steps"))}${serve}`);
    },
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

/**
 * Does this command gate curl a localhost server it never boots? Returns the port to
 * wrap, or null. Skips gates that ALREADY boot something (a serve/dom runner, an
 * inline server launch, `&`-backgrounding) so we never double-boot, and gates that
 * only hit EXTERNAL hosts (an env-var base URL, a real domain) — those need no server.
 */
export function serverGatePort(run: string): number | null {
  // Already boots a server? (a serve/dom runner, an inline launch, or a LONE `&` that
  // backgrounds a process — but NOT `&&`, which is just logical-AND between curls.)
  const loneBackground = /(?<![&>])&(?![&])(\s|$)/.test(run);
  if (loneBackground || /serve-gate\.mjs|dom-gate\.mjs|--serve\b|npm (run )?(start|dev)|uvicorn|flask run|gunicorn|hypercorn|\.listen\(|http\.server|nohup/.test(run)) {
    return null;
  }
  // A localhost:port bound to an external-service env var (VOUCHFLOW_BASE_URL=http://localhost:8001)
  // is a dependency the gate TALKS TO — a mock/provider already running — NOT a server the build
  // SERVES; booting it would fail (the build has no such server). Take the first localhost port
  // that ISN'T such a base URL.
  const re = /(\w*URL\s*=\s*['"]?)?https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})\b/g;
  for (let m = re.exec(run); m; m = re.exec(run)) {
    if (!m[1]) return Number(m[2]);
  }
  return null;
}

/** Wrap a localhost-curl gate so the harness boots the built server, waits, checks, tears down. */
export function wrapWithServeGate(run: string, port: number): string {
  return `node .squire/serve-gate.mjs --port ${port} --check ${sq(run)}`;
}

/**
 * Render a node's gate as a SPEC the BUILDER reads — the exact checks its work must pass — so it
 * builds TO the test instead of guessing the contract (the root cause of the field-name /
 * response-shape drift: the builder never saw the gate). Unwraps the serve-gate / dom-gate harness
 * wrappers to the underlying requests so the model sees real curls / DOM steps, not `node
 * serve-gate.mjs …`. The caller frames the example inputs as EXAMPLES — build the real feature so the
 * checks pass for ANY valid input, never hardcode the literals (over randomized inputs that's the
 * only winning move anyway).
 */
export function renderGateForBuilder(run: string): string {
  if (!run.trim()) return "";
  const serve = run.match(/serve-gate\.mjs --port (\d+) --check '([\s\S]*)'\s*$/);
  if (serve) {
    const checks = serve[2]!.replace(/'\\''/g, "'");
    return `The harness boots your server with \`npm start\` on port ${serve[1]} and runs these checks against the LIVE server — every one must pass:\n\n${checks}`;
  }
  const dom = run.match(/dom-gate\.mjs\s+'([^']+)'\s+'([\s\S]*?)'(?:\s+--serve\s+'([^']*)')?/);
  if (dom) {
    return `The harness serves your app${dom[3] ? ` (via \`${dom[3]}\`)` : ""}, opens ${dom[1]}, and asserts these DOM behaviors — every one must hold:\n\n${dom[2]}`;
  }
  return `Your work must pass this exact check, run from a fresh checkout:\n\n${run}`;
}

/**
 * A rough count of the INDEPENDENT behaviors a gate verifies — a deterministic proxy for how much
 * a single node must get right. A node whose gate asserts a dozen behaviors is over-sized for one
 * cheap turn (it thrashes; see the monolith timeout). Counts the dominant signals — live curls, DOM
 * asserts, test cases — falling back to &&-chained segments. Heuristic, used only to WARN at derive
 * time, never as a hard gate.
 */
export function gateBehaviorCount(run: string): number {
  const curls = (run.match(/\bcurl\b/gi) ?? []).length;
  const domAsserts = (run.match(/"assert"/g) ?? []).length;
  const segments = run.split("&&").filter((s) => s.trim().length > 0).length;
  return Math.max(curls, domAsserts, curls + domAsserts > 0 ? 0 : segments);
}

/**
 * Strip a self-boot/teardown preamble from a localhost-curl gate so the HARNESS serve-gate owns the
 * boot. The planner reliably writes its own fragile boot for a web-app server gate
 * (`npm install … && npm start & SERVER_PID=$! && sleep 3 && <curls> && kill $SERVER_PID`) — a race
 * (fixed `sleep`), a leaked process, and a lone `&` that makes serverGatePort think the gate already
 * self-boots (so it never gets serve-gate-wrapped and the skeleton scaffold never fires). Drop the
 * pure boot/teardown segments (npm install/start, sleep, kill, PID bookkeeping) and keep every check
 * segment (anything with a curl, including a `VAR=$(curl …)` capture). Deterministic, no model.
 */
export function stripSelfBootForServeGate(run: string): string {
  const BOOT =
    /(^|\s)(npm (install|ci|start|run|i)|yarn|pnpm|node (server|app|index)|python3?|flask|uvicorn|gunicorn|sleep|kill|wait|trap|nohup|disown)\b|SERVER_PID|[A-Z_]*PID=\$!|^\s*export\s/i;
  let s = run.trim();
  // 1. Drop a leading boot preamble — up to the first `curl` — but ONLY if that prefix is actually
  //    boot (npm/sleep/&…) and does NOT open a `$(` capture. Else a `SHORTCODE=$(curl …)` capture
  //    gets its `$(` eaten, leaving a dangling `)` that crashes the gate (`sh: ")" unexpected`).
  const i = s.search(/\bcurl\b/i);
  const prefix = i > 0 ? s.slice(0, i) : "";
  const opensCapture = (prefix.split("$(").length - 1) > (prefix.match(/\)/g) ?? []).length;
  if (i > 0 && !/\bcurl\b/i.test(prefix) && BOOT.test(prefix) && !opensCapture) s = s.slice(i).trim();
  // 2. Drop a trailing teardown (kill/wait/trap a backgrounded server), however separated.
  s = s.replace(/\s*[;&]+\s*(kill|wait|trap)\b.*$/i, "").trim();
  // 3. Drop any pure boot/teardown segment still sitting between `&&` checks.
  return s
    .split("&&")
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0 && (/curl/i.test(seg) || !BOOT.test(seg)))
    .join(" && ");
}

/**
 * Brief addendum for a node whose gate is a live serve-gate. The contract often pins a
 * TESTABLE factory (export createApp(), no listen()), which is incoherent with a gate that
 * curls a LIVE server — the build did exactly as told and the server never came up. Tell
 * the node to ALSO be runnable as a listening process on the gate's port (the harness will
 * also try to boot a factory export, but a self-listening entrypoint is the clean path).
 */
export function serveGateBriefNote(port: number): string {
  return [
    `RUNTIME GATE — this module is verified by STARTING it as a live server and curling it on port ${port}.`,
    `It MUST be runnable as a process that LISTENS on the port from $PORT (default ${port}) when run directly.`,
    `If you also export a factory (createApp/create_app) for tests, ADD a run-directly entrypoint that calls it and listens:`,
    `  Node:    if (require.main === module) (module.exports.createApp ? module.exports.createApp() : module.exports).listen(process.env.PORT || ${port});`,
    `  Flask:   if __name__ == "__main__": import os; app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "${port}")))`,
    `  FastAPI: if __name__ == "__main__": import os, uvicorn; uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "${port}")))  # NOT app.run() — FastAPI needs uvicorn`,
    `Bind 127.0.0.1 (or 0.0.0.0). The same file may both export the factory AND self-listen — keep it in this node's allowed files.`,
  ].join("\n");
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
export function renderGate(id: string, params: Record<string, unknown>): Gate {
  const pattern = getPattern(id);
  for (const required of pattern.params) {
    if (!(required in params)) {
      throw new SquireError("GATE_PATTERN_PARAM", `pattern "${id}" missing required param "${required}"`);
    }
  }
  return pattern.render(params);
}
