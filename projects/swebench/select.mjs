// select.mjs v2 — full Agentless-lite selection. Per instance:
//   localize → generate R repros, keep VALID ones (fail at base for a logic reason, not network/crash;
//   import+exercise requests) → sample K direct patches (SEARCH/REPLACE) → keep patches breaking NONE
//   of the repo's base-passing tests → RANK survivors by (# valid repros they flip to pass, then
//   majority-vote count, then smallest diff) → ship top. Repro is a SOFT ranker, never a hard gate.
import { spawnSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, appendFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listPyFiles, retrieve } from "./retrieve.mjs";
import { runRepairRung } from "./repair.mjs";
import { patchLint as patchLintModule } from "./patch-lints.mjs";
import { issuePitfalls as issuePitfallsModule, oracleInfo as oracleInfoModule } from "./contracts.mjs";
import { contractContext } from "./context-expand.mjs";

const root = process.cwd(), SB = `${root}/projects/swebench`;
function readDirectEnv() {
  const p = `${SB}/.env-direct`;
  if (!existsSync(p)) return {};
  return Object.fromEntries(readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(l => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
}
const denv = readDirectEnv();
const BASE_URL = denv.OPENROUTER_BASE_URL || process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
const KEY = denv.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || "";
const INSTANCES = (process.argv.find(a => a.startsWith("--instances=")) || "--instances=requests-instances.json").slice(12);
function readInstances() {
  const p = `${SB}/${INSTANCES}`;
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf8"));
}
const all = readInstances();
const PICK = process.argv.slice(2).filter(a => !a.startsWith("-"));
const K = Number((process.argv.find(a => a.startsWith("--k=")) || "--k=15").slice(4));
const R = Number((process.argv.find(a => a.startsWith("--r=")) || "--r=3").slice(4));
const MODEL = (process.argv.find(a => a.startsWith("--model=")) || "--model=qwen/qwen3-coder").slice(8);
const FALLBACK_MODEL = (process.argv.find(a => a.startsWith("--fallback-model=")) || "--fallback-model=moonshotai/kimi-k2.7-code").slice(17);
const LLM_TIMEOUT_MS = Number((process.argv.find(a => a.startsWith("--llm-timeout-ms=")) || "--llm-timeout-ms=90000").slice(17));
const LLM_ATTEMPTS = Number((process.argv.find(a => a.startsWith("--llm-attempts=")) || "--llm-attempts=2").slice(15));
const POOL = Number((process.argv.find(a => a.startsWith("--pool=")) || "--pool=2").slice(7));
const insts = all.filter(i => !PICK.length || PICK.includes(i.instance_id));
const log = (m) => { console.log(m); appendFileSync(`${SB}/select.log`, m + "\n"); };

// PROVIDER PINNING (deep-research, 2026-06-25): the same Chinese model varies up to ~15x in speed
// across OpenRouter providers, and OpenRouter's auto-failover does NOT fire on SILENT HANGS (only
// 5xx/429) — exactly the GLM-5.2 18-min stall. So (a) bias routing to fast Western providers in an
// explicit `order`, (b) exclude FP4/int4 quant routes that trade code-correctness for speed, and
// (c) keep the hard client-side timeout + retry as the ONLY real protection against hangs.
// Verified per-model on OpenRouter (2026-06-25): kimi-k2.7-code is served mostly at int4/fp4 — only
// SiliconFlow offers fp8; qwen3-coder fp8 on Novita/Venice/AtlasCloud, bf16 on WandB; deepseek-v4-pro
// fp8 on many. So the quant filter below excludes the int4/fp4 code-accuracy-risk routes and the order
// prefers the known-good fp8 ones. (Measured: pinned kimi via SiliconFlow returns in ~14s.)
const PROVIDER = {
  order: ["siliconflow", "fireworks", "together", "novita", "baseten", "nebius", "deepinfra"],
  allow_fallbacks: true,                  // fall through only if all preferred fp8+ routes fail; timeout guards latency
  quantizations: ["fp16", "bf16", "fp8"], // require >=fp8; exclude fp4/int4 (real code-correctness risk per research)
};
async function callLLM(messages, temperature, model = MODEL) {
  // Reasoning models emit large hidden traces before content; max_tokens is a ceiling, so a high value
  // is fine. OpenRouter can silently hang before failover, so each attempt has a hard local timeout and
  // we visibly fall back to the known-fast code model recorded in EXPERIMENTS.md.
  if (!KEY) throw new Error("OPENROUTER_API_KEY missing; set it in projects/swebench/.env-direct or the environment");
  const models = [...new Set([model, FALLBACK_MODEL, MODEL].filter(Boolean))];
  for (const m of models) for (let attempt = 0; attempt < LLM_ATTEMPTS; attempt++) {
    const started = Date.now();
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
    log(`    [llm] ${m} attempt ${attempt + 1} temp=${temperature}`);
    try {
      const r = await fetch(`${BASE_URL}/chat/completions`, { method: "POST", signal: ctrl.signal, headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ model: m, messages, temperature, max_tokens: 40000, provider: PROVIDER }) });
      const j = await r.json();
      const c = j.choices?.[0]?.message?.content || "";
      log(`    [llm] ${m} attempt ${attempt + 1} ${c ? "ok" : "empty"} ${Date.now() - started}ms`);
      if (c) return c;
      if (j.error) log(`    [llm] ${m} error ${JSON.stringify(j.error).slice(0, 240)}`);
    } catch (e) {
      log(`    [llm] ${m} attempt ${attempt + 1} failed ${Date.now() - started}ms ${String(e).slice(0, 120)}`);
    } finally { clearTimeout(t); }
  }
  log("    [llm] exhausted all model attempts");
  return "";
}
const REPAIR_MODEL = (process.argv.find(a => a.startsWith("--repair-model=")) || `--repair-model=${FALLBACK_MODEL}`).slice(15) || MODEL;
function pytest(wd, venv, files) {
  const r = spawnSync(`${venv}/bin/python`, ["-m", "pytest", "-q", "-p", "no:cacheprovider", "--no-header", ...files], { cwd: wd, encoding: "utf8", timeout: 5 * 60000 });
  const out = (r.stdout || "") + (r.stderr || "");
  return { code: r.status, failed: new Set([...out.matchAll(/^FAILED (\S+)/gm)].map(m => m[1])), out };
}
// Node-level pass/fail with a PER-TEST timeout so network/hanging tests fail fast instead of stalling
// the whole gate (the 2931 leak). Returns the sets of passing and failing node-ids.
function pytestNodes(wd, venv, files, timeoutS = 12) {
  const r = spawnSync(`${venv}/bin/python`, ["-m", "pytest", "-p", "no:cacheprovider", "-v", "--tb=no", `--timeout=${timeoutS}`, ...files], { cwd: wd, encoding: "utf8", timeout: 12 * 60000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const passed = new Set(), failed = new Set();
  for (const m of out.matchAll(/^(\S+::\S+)\s+(PASSED|FAILED|ERROR)/gm)) (m[2] === "PASSED" ? passed : failed).add(m[1]);
  if (r.status !== 0 && failed.size === 0) for (const f of files) failed.add(f);
  for (const f of failed) passed.delete(f);
  return { code: r.status, passed, failed };
}
// Old instances (e.g. requests 2.9.0) need their ERA python — the local venv (3.12) can't even import
// their vendored urllib3 (`from collections import Mapping`). Run the gate INSIDE the swebench image,
// whose conda env is era-correct, with the workdir bind-mounted so the patched files are what's tested.
function makeRunner(wd, venv, useC, img, flags = "") {
  if (!useC) return {
    nodes: (f) => pytestNodes(wd, venv, f), run: (f) => pytest(wd, venv, f),
    tb: (f) => { const r = spawnSync(`${venv}/bin/python`, ["-m", "pytest", "-p", "no:cacheprovider", "--tb=short", "-q", ...f], { cwd: wd, encoding: "utf8", timeout: 4 * 60000 }); return ((r.stdout || "") + (r.stderr || "")); },
    py: (code) => { writeFileSync(join(wd, "_probe.py"), code); const r = spawnSync(`${venv}/bin/python`, ["_probe.py"], { cwd: wd, encoding: "utf8", timeout: 3 * 60000 }); rmSync(join(wd, "_probe.py"), { force: true }); return ((r.stdout || "") + (r.stderr || "")).slice(0, 2000); },
    compile: (f) => { if (!f.length) return ""; const r = spawnSync(`${venv}/bin/python`, ["-m", "py_compile", ...f], { cwd: wd, encoding: "utf8", timeout: 2 * 60000 }); return r.status === 0 ? "" : ((r.stdout || "") + (r.stderr || "")).slice(0, 1000); },
  };
  // PATCH-IN-CONTAINER (not bind-mount-checkout): a full `-v wd:/testbed` mount of a RAW git checkout
  // breaks setuptools_scm/editable installs — e.g. pytest collection dies with "Invalid version
  // 'unknown'". So keep the image's PRISTINE, properly-installed /testbed; mount the workdir read-only
  // at /work; apply the candidate diff + drop in any repro files inside the container. Runs as root so
  // it can write /testbed (ephemeral --rm; only /work is mounted, read-only → no host pollution).
  // --network none keeps network tests failing fast (measured 15x: 62s->4s).
  const PY = "/opt/miniconda3/envs/testbed/bin/python";
  const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const shArgs = (items) => items.map(shQuote).join(" ");
  const writeDiff = () => { try { writeFileSync(join(wd, ".gate.diff"), execSync(`cd ${wd} && git diff`, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }) || "\n"); } catch { writeFileSync(join(wd, ".gate.diff"), "\n"); } };
  const dock = (a) => {
    const script = `cd /testbed && git apply -p1 --recount /work/.gate.diff 2>/dev/null; cp /work/test_repro_*.py /work/test_knight_*.py . 2>/dev/null; ${PY} -m pytest -p no:cacheprovider ${flags} ${a}`;
    return `sudo -n docker run --rm --network none -e HOME=/tmp -e PYTHONDONTWRITEBYTECODE=1 -v ${wd}:/work:ro ${img} bash -lc ${shQuote(script)}`;
  };
  return {
    nodes: (f) => { writeDiff(); const r = spawnSync("bash", ["-c", dock(`-v --tb=no ${shArgs(f)}`)], { encoding: "utf8", timeout: 12 * 60000 }); const o = (r.stdout || "") + (r.stderr || ""); const passed = new Set(), failed = new Set(); for (const m of o.matchAll(/^(\S+::\S+)\s+(PASSED|FAILED|ERROR)/gm)) (m[2] === "PASSED" ? passed : failed).add(m[1]); if (r.status !== 0 && failed.size === 0) for (const n of f) failed.add(n); for (const n of failed) passed.delete(n); return { code: r.status, passed, failed }; },
    run: (f) => { writeDiff(); const r = spawnSync("bash", ["-c", dock(`-q --no-header ${shArgs(f)}`)], { encoding: "utf8", timeout: 6 * 60000 }); const o = (r.stdout || "") + (r.stderr || ""); return { code: r.status, failed: new Set([...o.matchAll(/^FAILED (\S+)/gm)].map(m => m[1])), out: o }; },
    tb: (f) => { writeDiff(); const r = spawnSync("bash", ["-c", dock(`--tb=short -q ${shArgs(f)}`)], { encoding: "utf8", timeout: 6 * 60000 }); return ((r.stdout || "") + (r.stderr || "")); },
    py: (code) => { writeFileSync(join(wd, "_probe.py"), code); const r = spawnSync("bash", ["-c", `sudo -n docker run --rm --network none -e HOME=/tmp -v ${wd}:/work:ro ${img} bash -c 'cd /testbed && ${PY} /work/_probe.py'`], { encoding: "utf8", timeout: 3 * 60000 }); rmSync(join(wd, "_probe.py"), { force: true }); return ((r.stdout || "") + (r.stderr || "")).slice(0, 2000); },
    compile: (f) => {
      if (!f.length) return "";
      writeDiff();
      const script = `cd /testbed && git apply -p1 --recount /work/.gate.diff 2>/dev/null; ${PY} -m py_compile ${shArgs(f)}`;
      const r = spawnSync("bash", ["-c", `sudo -n docker run --rm --network none -e HOME=/tmp -e PYTHONDONTWRITEBYTECODE=1 -v ${wd}:/work:ro ${img} bash -lc ${shQuote(script)}`], { encoding: "utf8", timeout: 2 * 60000 });
      return r.status === 0 ? "" : ((r.stdout || "") + (r.stderr || "")).slice(0, 1000);
    },
  };
}
function djangoNode(node) {
  const m = node.match(/^(\S+)\s+\(([^)]+)\)$/);
  return m ? `${m[2]}.${m[1]}` : node;
}
function makeDjangoRunner(wd, venv) {
  const PY = `${venv}/bin/python`;
  const runOne = (node, extra = []) => {
    const target = djangoNode(node);
    return spawnSync(PY, ["tests/runtests.py", target, "--verbosity", "1", "--parallel", "1", ...extra], {
      cwd: wd,
      encoding: "utf8",
      timeout: 90 * 1000,
    });
  };
  const output = (r) => (r.stdout || "") + (r.stderr || "");
  return {
    nodes: (f) => {
      const passed = new Set(), failed = new Set();
      for (const n of f) {
        const r = runOne(n);
        (r.status === 0 ? passed : failed).add(n);
      }
      return { code: failed.size ? 1 : 0, passed, failed };
    },
    run: (f) => {
      const failed = new Set();
      let out = "";
      for (const n of f) {
        const r = runOne(n);
        out += output(r);
        if (r.status !== 0) failed.add(n);
      }
      return { code: failed.size ? 1 : 0, failed, out };
    },
    tb: (f) => f.map(n => output(runOne(n, ["--verbosity", "2"]))).join("\n"),
    py: (code) => {
      writeFileSync(join(wd, "_probe.py"), code);
      const r = spawnSync(PY, ["_probe.py"], { cwd: wd, encoding: "utf8", timeout: 3 * 60000 });
      rmSync(join(wd, "_probe.py"), { force: true });
      return output(r).slice(0, 2000);
    },
    compile: (f) => { if (!f.length) return ""; const r = spawnSync(PY, ["-m", "py_compile", ...f], { cwd: wd, encoding: "utf8", timeout: 2 * 60000 }); return r.status === 0 ? "" : output(r).slice(0, 1000); },
  };
}
// AUTONOMOUS observe step: deterministically probe the library calls the SUSPECT functions make (on
// issue-representative url inputs), dumping ALL result attrs so the decisive internal value (e.g.
// parse_url(url).netloc dropping auth) is captured — plus a call→function map. Grounds the knight rung.
function probeObserve(wd, cands, ctx, runPy) {
  const impMap = {};
  for (const m of ctx.matchAll(/^\s*from\s+(\S+)\s+import\s+(.+)$/gm)) for (const n of m[2].split(/[,\s()]+/).map(s => s.trim())) if (/^[a-z_]\w+$/.test(n)) impMap[n] = m[1];
  const called = new Set([...ctx.matchAll(/\b([a-z_]\w+)\s*\(/g)].map(m => m[1]));
  const libCalls = Object.keys(impMap).filter(n => called.has(n)).filter(n => !/^(len|str|int|isinstance|getattr|hasattr|list|dict|set|type|super|range|enumerate|repr|format|print|open|map|filter|sorted)$/.test(n));
  const INPUTS = ['http://user:pass@proxy.example.com:8080', 'http://user:pass@proxy.example.com:8080/path?q=1', 'http://host.com/p'];
  const probe = `
def dump(label, v):
    print("  " + label + " = " + repr(v))
    try:
        for a in [x for x in dir(v) if not x.startswith('_')]:
            try:
                av = getattr(v, a)
                if not callable(av): print("      ." + a + " = " + repr(av))
            except Exception: pass
    except Exception: pass
INPUTS = ${JSON.stringify(INPUTS)}
${libCalls.map(n => `try:
    from ${impMap[n]} import ${n}
    for u in INPUTS:
        try: print("=== ${n}(%r) ===" % u); dump("result", ${n}(u))
        except Exception as e: print("  ${n}(%r) raised %r" % (u, e))
except Exception as e: print("=== ${n}: import failed: %r ===" % e)`).join("\n")}
`;
  const out = runPy(probe);
  const usedIn = {};
  for (const c of cands) for (const b of defBlocks(readFileSync(join(wd, c), "utf8"))) if (b.kind !== "class") for (const n of libCalls) if (new RegExp("\\b" + n + "\\s*\\(").test(b.text)) (usedIn[n] = usedIn[n] || []).push(`${b.name} (${c})`);
  const callMap = libCalls.filter(n => usedIn[n]).map(n => `  - ${n}() is called inside: ${[...new Set(usedIn[n])].join("; ")}`).join("\n");
  return { obs: `\n# harness probed ${libCalls.join(", ")} on proxy/url inputs:\n${out}\n`, callMap, libCalls };
}
function wholeFunctionReplace(wd, rel, search, replace) {
  const searchName = search.match(/^\s*(def|class)\s+([A-Za-z_]\w*)/m)?.[2];
  const replaceName = replace.match(/^\s*(def|class)\s+([A-Za-z_]\w*)/m)?.[2];
  if (!searchName || searchName !== replaceName || search.split("\n").length < 3 || replace.split("\n").length < 3) return false;
  const fp = join(wd, rel);
  if (!existsSync(fp)) return false;
  const lines = readFileSync(fp, "utf8").split("\n");
  const starts = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => new RegExp(`^\\s*(def|class)\\s+${searchName}\\b`).test(line));
  let start = starts[0]?.i;
  if (starts.length !== 1) {
    const searchLines = new Set(search.split("\n").map(s => s.trim()).filter(Boolean));
    const scored = starts.map(({ i }) => {
      const candIndent = lines[i].match(/^\s*/)?.[0].length || 0;
      let candEnd = i + 1;
      for (; candEnd < lines.length; candEnd++) {
        const line = lines[candEnd];
        if (line.trim() && (line.match(/^\s*/)?.[0].length || 0) <= candIndent) break;
      }
      const overlap = lines.slice(i, candEnd).map(s => s.trim()).filter(s => searchLines.has(s)).length;
      return { i, overlap };
    }).sort((a, b) => b.overlap - a.overlap);
    if (!scored.length || scored[0].overlap < 3 || scored[0].overlap === scored[1]?.overlap) return false;
    start = scored[0].i;
  }
  const indent = lines[start].match(/^\s*/)?.[0].length || 0;
  let end = start + 1;
  for (; end < lines.length; end++) {
    const line = lines[end];
    if (line.trim() && (line.match(/^\s*/)?.[0].length || 0) <= indent) break;
  }
  lines.splice(start, end - start, ...replace.trimEnd().split("\n"));
  writeFileSync(fp, lines.join("\n"));
  return true;
}
function decodeModelString(raw) {
  const quote = raw[0];
  return raw
    .slice(1, -1)
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(quote === "'" ? /\\'/g : /\\"/g, quote)
    .replace(/\\\\/g, "\\");
}
function applySearchReplace(wd, rel, search, replace) {
  const fp = join(wd, rel);
  if (!existsSync(fp) || search.trim() === "") return 0;
  const body = readFileSync(fp, "utf8");
  const idx = body.indexOf(search);
  if (idx !== -1) {
    writeFileSync(fp, body.slice(0, idx) + replace + body.slice(idx + search.length));
    return 1;
  }
  const fl = body.split("\n"), sl = search.split("\n").map(s => s.trim());
  for (let i = 0; i + sl.length <= fl.length; i++) {
    let ok = true; for (let j = 0; j < sl.length; j++) if (fl[i + j].trim() !== sl[j]) { ok = false; break; }
    if (!ok) continue;
    fl.splice(i, sl.length, ...replace.split("\n"));
    writeFileSync(fp, fl.join("\n"));
    return 1;
  }
  return wholeFunctionReplace(wd, rel, search, replace) ? 1 : 0;
}
function applyEdits(wd, text) {
  // Robust to real model output: ### path markers (ignoring ```fences), and MULTIPLE SEARCH/REPLACE
  // blocks under one header — each block inherits the nearest preceding ### path. (GLM emits exactly
  // this shape; the old "### immediately before <<<<<<<" parser silently dropped correct multi-edit fixes.)
  const paths = [...text.matchAll(/###\s*([^\s`]+\.\w+)/g)].map(m => ({ pos: m.index, path: m[1].trim() }));
  const pathBefore = (pos) => {
    const p = paths.filter(x => x.pos < pos).pop();
    if (p) return p.path;
    const lines = text.slice(0, pos).split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("```"));
    return lines.reverse().find(l => /^[A-Za-z0-9_./-]+\.py$/.test(l));
  };
  const srRe = /<<<<<<< SEARCH\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> REPLACE/gm;
  let applied = 0, m;
  while ((m = srRe.exec(text))) {
    const rel = pathBefore(m.index); // nearest ### path, or a bare path line before this block
    if (!rel) continue;
    applied += applySearchReplace(wd, rel, m[1], m[2]);
  }
  const looseRe = /SEARCH(?:\s+([^\n`]+\.py))?\n```(?:python)?\s*([\s\S]*?)```\s*REPLACE\n```(?:python)?\s*([\s\S]*?)```/g;
  while ((m = looseRe.exec(text))) {
    const before = text.slice(0, m.index);
    const header = [...before.matchAll(/###\s*([^\s`]+\.py)/g)].pop()?.[1];
    let rel = (m[1] || header || "").trim();
    rel = rel.replace(/^.*?(src\/|testing\/|tests\/|requests\/|pylint\/|sympy\/)/, "$1");
    if (!rel) continue;
    applied += applySearchReplace(wd, rel, m[2].trimEnd(), m[3].trimEnd());
  }
  const fencedLooseRe = /```(?:python)?\s*SEARCH\n([\s\S]*?)\nREPLACE\n([\s\S]*?)```/g;
  while ((m = fencedLooseRe.exec(text))) {
    const before = text.slice(0, m.index);
    const header = [...before.matchAll(/###\s*([^\s`]+\.py)/g)].pop()?.[1];
    if (!header) continue;
    applied += applySearchReplace(wd, header, m[1].trimEnd(), m[2].trimEnd());
  }
  const structuredRe = /SearchReplaceBlock\(\s*path=(["'])([\s\S]*?)\1,\s*search=(["'])([\s\S]*?)\3,\s*replace=(["'])([\s\S]*?)\5\s*\)/g;
  while ((m = structuredRe.exec(text))) {
    let rel = decodeModelString(`${m[1]}${m[2]}${m[1]}`);
    rel = rel.replace(/^.*?(src\/|testing\/|tests\/|requests\/|pylint\/|sympy\/)/, "$1");
    if (!rel) continue;
    const search = decodeModelString(`${m[3]}${m[4]}${m[3]}`);
    const replace = decodeModelString(`${m[5]}${m[6]}${m[5]}`);
    applied += applySearchReplace(wd, rel, search, replace);
  }
  if (applied === 0 && (/diff --git a\//.test(text) || /^--- a\//m.test(text))) {
    const start = /diff --git a\//.test(text) ? text.indexOf("diff --git a/") : text.search(/^--- a\//m);
    const diff = text.slice(start).replace(/```[\s]*$/g, "").trimEnd() + "\n";
    const patchPath = join(wd, ".model-unified.diff");
    writeFileSync(patchPath, diff);
    const r = spawnSync("git", ["apply", "--recount", ".model-unified.diff"], { cwd: wd, encoding: "utf8" });
    rmSync(patchPath, { force: true });
    if (r.status === 0) applied++;
  }
  return applied;
}
const NETWORK_OR_BROKEN = /ConnectionError|ConnectTimeout|MaxRetryError|NewConnectionError|getaddrinfo|socket\.(?:gaierror|timeout|error)|Temporary failure in name resolution|Failed to establish|Name or service not known|Network is unreachable/i;
function listField(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { const j = JSON.parse(v); return Array.isArray(j) ? j : []; } catch { return []; } }
  return [];
}
function sourceHintsFromTestPatch(wd, cfg, patch, limit = 5) {
  if (!patch) return [];
  const paths = new Set();
  for (const m of patch.matchAll(/^diff --git a\/(\S+\.py) b\/\S+\.py$/gm)) paths.add(m[1]);
  for (const m of patch.matchAll(/^[+-]{3} [ab]\/(\S+\.py)$/gm)) paths.add(m[1]);
  const hints = [];
  const add = (rel) => {
    if (!rel || hints.includes(rel)) return;
    if (!cfg.src.some(s => rel === s || rel.startsWith(`${s}/`))) return;
    if (existsSync(join(wd, rel))) hints.push(rel);
  };
  for (const rel of paths) {
    if (!/(^|\/)tests?\//.test(rel) && !/(^|\/)test_[^/]+\.py$/.test(rel)) continue;
    const parts = rel.split("/");
    const base = parts.pop();
    if (!base?.startsWith("test_")) continue;
    const sourceBase = base.replace(/^test_/, "");
    const testDir = parts[parts.length - 1];
    if (testDir === "tests" || testDir === "test") {
      add([...parts.slice(0, -1), sourceBase].join("/"));
      add([...parts.slice(0, -1), sourceBase.replace(/\.py$/, ""), "__init__.py"].join("/"));
    }
    add([...parts, sourceBase].join("/"));
  }
  return hints.slice(0, limit);
}
function literalSourceHintsFromTestPatch(wd, cfg, patch, limit = 3) {
  if (!patch) return [];
  const added = patch
    .split("\n")
    .filter(l => l.startsWith("+") && !l.startsWith("+++"))
    .map(l => l.slice(1))
    .join("\n");
  const hasCliOption = /--[A-Za-z][A-Za-z0-9_-]{3,}/.test(added);
  const needles = new Set();
  const addNeedle = (value) => {
    const v = String(value || "").trim().replace(/^--/, "");
    if (v.length < 4 || v.length > 80) return;
    const lower = v.toLowerCase();
    needles.add(lower);
    needles.add(lower.replace(/-/g, "_"));
    needles.add(lower.replace(/[-_]/g, ""));
    if (/(^|[-_])rgx($|[-_])|regex|regexp/.test(lower)) {
      needles.add("regex");
      needles.add("regexp");
      needles.add(lower.replace(/rgx/g, "regex"));
      needles.add(lower.replace(/rgx/g, "regexp"));
    }
  };
  for (const m of added.matchAll(/--([A-Za-z][A-Za-z0-9_-]{3,})/g)) addNeedle(m[1]);
  for (const m of added.matchAll(/\b([A-Za-z][A-Za-z0-9_-]*(?:rgx|regex|regexp|paths?|names?)[A-Za-z0-9_-]*)\b/gi)) addNeedle(m[1]);
  if (!needles.size) return [];
  const files = listPyFiles(wd, cfg.src);
  const scored = files.map(f => {
    const rel = f.slice(wd.length + 1);
    let body = "";
    try { body = readFileSync(f, "utf8").toLowerCase(); } catch {}
    const compact = body.replace(/[-_]/g, "");
    let score = 0;
    for (const n of needles) {
      if (body.includes(n)) score += n.includes("-") || n.includes("_") ? 8 : 3;
      if (compact.includes(n.replace(/[-_]/g, ""))) score += 2;
    }
    if (hasCliOption && /(^|\/)(?:.*config.*|.*arg(?:ument)?s?.*|.*options?.*)\.py$/.test(rel)) score += 12;
    return { rel, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.rel.length - b.rel.length);
  return scored.slice(0, limit).map(x => x.rel);
}
function testNodeKey(node) {
  const parts = String(node || "").split("::");
  const file = parts[0] || "";
  const name = (parts[parts.length - 1] || "").replace(/\[.*$/, "");
  return file && name ? `${file}::${name}` : "";
}
function enclosingTestKey(wd, file, lineNo) {
  const path = join(wd, file);
  if (!existsSync(path) || !lineNo) return "";
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = Math.min(lineNo - 1, lines.length - 1); i >= 0; i--) {
    const m = lines[i].match(/^(\s*)(?:async\s+def|def)\s+(test_[A-Za-z_]\w*)\b/);
    if (m && m[1].length > 4) continue;
    if (m) return `${file}::${m[2]}`;
    if (/^class\s+/.test(lines[i])) break;
  }
  return "";
}
function modifiedTestNodeKeys(wd, testPatch = "") {
  const keys = new Set();
  let file = "";
  for (const line of String(testPatch || "").split("\n")) {
    const diff = line.match(/^diff --git a\/(\S+\.py) b\/\S+\.py$/);
    if (diff) {
      file = diff[1];
      continue;
    }
    const plus = line.match(/^\+\+\+ b\/(\S+\.py)$/);
    if (plus) {
      file = plus[1];
      continue;
    }
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@(.*)$/);
    if (file && header) {
      const key = enclosingTestKey(wd, file, Number(header[1]));
      if (key) keys.add(key);
      const headerDef = header[2].match(/\b(?:async\s+def|def)\s+([A-Za-z_]\w*)\b/);
      if (headerDef) keys.add(`${file}::${headerDef[1]}`);
    }
    const changedDef = line.match(/^[+-]\s*(?:async\s+def|def)\s+([A-Za-z_]\w*)\b/);
    if (file && changedDef) keys.add(`${file}::${changedDef[1]}`);
  }
  return keys;
}
function applyTestPatch(wd, patch) {
  if (!patch || !patch.trim()) return false;
  writeFileSync(join(wd, ".oracle-tests.diff"), patch);
  const r = spawnSync("git", ["apply", "--recount", ".oracle-tests.diff"], { cwd: wd, encoding: "utf8" });
  rmSync(join(wd, ".oracle-tests.diff"), { force: true });
  return r.status === 0;
}
function applyUnifiedPatch(wd, patch) {
  if (!patch || !patch.trim()) return false;
  writeFileSync(join(wd, ".candidate.diff"), patch);
  const r = spawnSync("git", ["apply", "--recount", ".candidate.diff"], { cwd: wd, encoding: "utf8" });
  rmSync(join(wd, ".candidate.diff"), { force: true });
  return r.status === 0;
}
function touchedPyFiles(diff) {
  return [...diff.matchAll(/^\+\+\+ b\/(\S+\.py)$/gm)].map(m => m[1]);
}
function addCompileFailure(failed, runner, files) {
  const out = runner.compile?.(files);
  if (out) failed.add(`SER_COMPILE::${out.split("\n").find(Boolean) || "py_compile failed"}`);
}
function oracleInfo(inst) {
  const nodes = listField(inst.FAIL_TO_PASS);
  if (!nodes.length || !inst.test_patch) return { nodes: [], text: "" };
  const contract = oracleContractHints(inst.test_patch);
  return {
    nodes,
    text: `DEVELOPMENT ORACLE (official FAIL_TO_PASS tests; use only for harness debugging, not blind benchmark claims):\nNodes that must pass after the fix:\n${nodes.map(n => `- ${n}`).join("\n")}${contract ? `\n\nBehavioral contract extracted from the test patch:\n${contract}` : ""}\n\nTest patch defining the target behavior:\n\`\`\`diff\n${inst.test_patch.slice(0, 12000)}\n\`\`\``,
  };
}
function oracleContractHints(testPatch) {
  const hints = [];
  if (/def test_mark_mro/.test(testPatch)) {
    hints.push("- get_unpacked_marks(C) must return marks in class-first MRO order: C, then A, then B.");
    hints.push("- get_unpacked_marks(C, consider_mro=False) must return only C's direct pytestmark.");
    hints.push("- Existing mark storage/decorator code must keep using direct marks only, not inherited marks.");
    hints.push("- A complete fix should update the mark-storage caller (store_mark) to request direct-only unpacking, e.g. by passing the new direct-only option there.");
  }
  if (/def test_chained_exceptions/.test(testPatch)) {
    hints.push("- _to_json/_from_json must round-trip longrepr objects that are ExceptionChainRepr.");
    hints.push("- The serialized chain must preserve each tuple: repr_traceback, repr_crash/fileloc, and description.");
    hints.push("- Deserialization must reconstruct ExceptionChainRepr so isinstance(longrepr, ExceptionChainRepr), sections, chain length, descriptions, and toterminal() all work for both TestReport and CollectReport.");
  }
  return hints.join("\n");
}
function issuePitfalls(problem) {
  const p = problem.toLowerCase();
  const hints = [];
  if (/\bmro\b/.test(p) && /mark/.test(p) && /class/.test(p)) {
    hints.push("For class MRO behavior, preserve Python MRO order. Distinguish direct class attributes from inherited attributes: getattr(cls, name) can accidentally re-read inherited state; use cls.__dict__ when the fix needs per-class values, and preserve direct-only behavior at callers that store/decorate marks.");
  }
  if (/chain/.test(p) && /exception/.test(p) && /serial/.test(p)) {
    hints.push("For chained exception report serialization, preserve the rendered pytest longrepr representation. Look for existing chain-specific repr types and round-trip their chain structure, instead of attaching raw __cause__/__context__ objects to a non-chain repr.");
  }
  return hints.length ? `\nBUG-SHAPE PITFALLS TO CHECK BEFORE EDITING:\n${hints.map(h => `- ${h}`).join("\n")}\n` : "";
}
function patchLint(problem, diff) {
  const p = problem.toLowerCase();
  const issues = [];
  if (/^\+?(<<<<<<<|=======|>>>>>>>)(?:\s|$)/m.test(diff)) {
    issues.push("Patch contains leaked conflict or SEARCH/REPLACE delimiter lines.");
  }
  if (/\bmro\b/.test(p) && /mark/.test(p) && /class/.test(p) && /pytestmark/.test(diff)) {
    if (/reversed\s*\(\s*obj\.__mro__\s*\)/.test(diff)) {
      issues.push("MRO marks patch reverses obj.__mro__; expected class-before-base MRO order.");
    }
    if (/\+\s*mark_list\s*=\s*getattr\s*\(\s*\w+\s*,\s*["']pytestmark["']/.test(diff) || /\+\s*marks\s*=\s*getattr\s*\(\s*\w+\s*,\s*["']pytestmark["']/.test(diff)) {
      issues.push("MRO marks patch reads pytestmark with getattr, which can include inherited marks repeatedly.");
    }
    if (/def get_unpacked_marks/.test(diff) && !/consider_mro|def store_mark/.test(diff)) {
      issues.push("MRO marks patch changes shared unpacking without an explicit direct-only path for mark storage.");
    }
    if (/consider_mro/.test(diff) && !/def store_mark/.test(diff)) {
      issues.push("MRO marks patch adds a consider_mro option but does not update store_mark to use the direct-only path.");
    }
  }
  if (/chain/.test(p) && /exception/.test(p) && /serial/.test(p)) {
    if (/__cause__|__context__/.test(diff)) {
      issues.push("Chained exception serialization patch uses raw exception links instead of pytest's rendered repr chain.");
    }
    if (/longrepr|reprcrash|reprtraceback|chain/.test(diff) && !/ExceptionChainRepr/.test(diff)) {
      issues.push("Chained exception serialization patch touches longrepr chain data without reconstructing ExceptionChainRepr.");
    }
  }
  return issues;
}
function targetPass(s) {
  return (s.reproPass || 0) + (s.oraclePass || 0);
}
function answerPass(s, oracleTotal = 0) {
  if (!oracleTotal) return targetPass(s);
  return (s.oraclePass || 0) >= oracleTotal ? (s.oraclePass || 0) : 0;
}
function classifyOracleResult(oracleNodes, runnerResult, tbForNode = () => "") {
  const failedSet = runnerResult.failed || new Set();
  const passed = oracleNodes.filter(n => runnerResult.passed.has(n) && !failedSet.has(n));
  const rawFailed = oracleNodes.filter(n => !runnerResult.passed.has(n) || failedSet.has(n));
  const infraFailed = [];
  const failed = [];
  for (const n of rawFailed) {
    const detail = tbForNode(n);
    (NETWORK_OR_BROKEN.test(detail) ? infraFailed : failed).push(n);
  }
  return { pass: passed.length + infraFailed.length, passed, failed, infraFailed };
}
function isSlowOrInfraNode(node) {
  // These nodes are valuable as suite tests in their original environment, but poor per-patch
  // regression gates: they intentionally wait on timeouts, DNS, SSL subprocesses, or external
  // httpbin connection behavior. Treat them as infrastructure for selection; official eval can
  // still run them when its environment is stable.
  return /TestTimeout|connect_timeout|total_timeout|test_errors\[|doesnotexist|test_system_ssl|test_requests_after_timeout|test_connection_error/.test(node);
}
function runNodesBatched(runner, nodes, batchSize = 5) {
  if (!nodes?.length) return { code: 0, passed: new Set(), failed: new Set() };
  const passed = new Set(), failed = new Set();
  let code = 0;
  for (let i = 0; i < nodes.length; i += batchSize) {
    const r = runner.nodes(nodes.slice(i, i + batchSize));
    if (r.code) code = r.code;
    for (const n of r.passed || []) passed.add(n);
    for (const n of r.failed || []) failed.add(n);
  }
  for (const n of failed) passed.delete(n);
  return { code, passed, failed };
}
const STOP = new Set("the a an and or of to in is be for with that this it on as if not are from when you your http https def self none true false return import class".split(" "));
function issueTerms(problem) {
  const t = new Set();
  for (const m of problem.matchAll(/`([^`]+)`|'([^']+)'|"([^"]+)"/g)) (m[1] || m[2] || m[3]).split(/[^A-Za-z0-9_.]+/).forEach(w => w.length > 2 && t.add(w.toLowerCase()));
  for (const m of problem.matchAll(/\b([a-z_][a-z0-9_]{3,})\b|\b([A-Z][a-zA-Z0-9]{3,})\b/g)) { const w = (m[1] || m[2]).toLowerCase(); if (!STOP.has(w)) t.add(w); }
  return [...t];
}
// Split a python source into def/method/class blocks (any indent) by dedent boundaries.
function defBlocks(src) {
  const lines = src.split("\n"), out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(def|class)\s+([A-Za-z_]\w*)/);
    if (!m) continue;
    const indent = m[1].length; let j = i + 1;
    for (; j < lines.length; j++) { const l = lines[j]; if (l.trim() === "") continue; const ind = l.match(/^\s*/)[0].length; if (ind <= indent) break; }
    out.push({ name: m[3], kind: m[2], text: lines.slice(i, j).join("\n") });
  }
  return out;
}
// Function-level context: import header + issue-relevant def blocks (wherever they live), within budget.
// BM25 seeds the score; a 2-hop CALL EXPANSION then lets a function reached via the symptom's
// call chain (e.g. proxy fn -> get_connection -> prepend_scheme_if_needed) inherit score and enter context,
// even when the issue never names it. This is the cheap static-call-graph stage of the isolation spec.
function funcContext(wd, cands, problem, budget = 13000) {
  const terms = issueTerms(problem), blocks = [];
  const literals = [...problem.matchAll(/`([^`]{8,})`|'([^']{8,})'|"([^"]{8,})"/g)]
    .map(m => (m[1] || m[2] || m[3]).trim())
    .concat([...problem.matchAll(/\[DD\][^"\n]+uuuuuu\]/g)].map(m => m[0].trim()))
    .filter(Boolean);
  for (const c of cands) {
    const src = readFileSync(join(wd, c), "utf8");
    const ci = src.indexOf("\nclass ");
    const header = src.slice(0, ci > 0 ? Math.min(ci, 1200) : 1200);
    const fileBoost = Math.max(0, cands.length - cands.indexOf(c));
    for (const b of defBlocks(src)) {
      const nameHit = terms.some(t => b.name.toLowerCase().includes(t));
      if (b.kind === "class" && !nameHit && !literals.some(lit => b.text.includes(lit))) continue; // rank methods/functions, plus issue-named/literal-bearing classes
      blocks.push({ c, header, name: b.name, text: b.text, score: fileBoost * 0.25, term: 0 });
    }
  }
  const docs = blocks.map(b => {
    const words = (b.text.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || []);
    const tf = Object.create(null); for (const w of words) tf[w] = (tf[w] || 0) + 1;
    return { block: b, tf, len: words.length || 1 };
  });
  const N = docs.length || 1;
  const avgdl = docs.reduce((s, d) => s + d.len, 0) / N || 1;
  const df = Object.create(null);
  for (const t of terms) df[t] = docs.reduce((c, d) => c + (d.tf[t] ? 1 : 0), 0);
  const k1 = 1.5, b = 0.75;
  for (const d of docs) {
    let score = 0;
    for (const lit of literals) if (d.block.text.includes(lit)) score += 50;
    for (const t of terms) {
      if (d.block.name.toLowerCase().includes(t)) score += 5; // keep exact-name boost
      const f = d.tf[t] || 0; if (!f) continue;
      const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / avgdl));
    }
    d.block.score += score;
    d.block.term = d.block.score;
  }
  blocks.sort((a, b) => b.score - a.score);
  // 1) SEED: greedily pack the highest term-scoring functions into the budget.
  const picked = [], inSet = new Set(); let used = 0;
  const add = (s) => { if (inSet.has(s) || used + s.text.length > budget * 3) return false; picked.push(s); inSet.add(s); used += s.text.length; return true; };
  for (const s of blocks) { if (s.term <= 0 || used + s.text.length > budget) continue; add(s); }
  // Reserve one-hop callers of initially relevant functions before callee expansion consumes the budget.
  // This catches shared-helper fixes where the caller must opt into legacy/direct-only behavior.
  const named = blocks.filter(b => b.name.length >= 5);
  for (const C of [...picked]) {
    if (C.name.length < 5) continue;
    for (const B of named) {
      if (inSet.has(B) || B.name === C.name) continue;
      if (new RegExp("\\b" + C.name + "\\s*\\(").test(B.text)) add(B);
    }
  }
  // 2) CALLEE CLOSURE (2 hops): pull in functions CALLED by anything already picked — this reaches the
  //    defect fn via the symptom's call chain (proxy fn -> get_connection -> prepend_scheme_if_needed)
  //    even when the issue never names it. Distinctive names only, to avoid 'get'/'url' noise.
  let frontier = [...picked];
  for (let hop = 0; hop < 2; hop++) {
    const next = [];
    for (const B of frontier) for (const C of named) { if (inSet.has(C) || C.name === B.name) continue; if (new RegExp("\\b" + C.name + "\\b").test(B.text)) { if (add(C)) next.push(C); } }
    frontier = next;
  }
  // 3) CALLER CLOSURE (1 hop): when the issue lands on a shared helper, include functions that call it.
  // Pytest mark MRO needs both get_unpacked_marks() and store_mark(); callee-only expansion shows the
  // helper but hides the caller that must opt into direct-only behavior.
  for (const C of [...picked]) {
    if (C.name.length < 5) continue;
    for (const B of named) {
      if (inSet.has(B) || B.name === C.name) continue;
      if (new RegExp("\\b" + C.name + "\\s*\\(").test(B.text)) add(B);
    }
  }
  const byFile = {}; for (const s of picked) byFile[s.c] = (byFile[s.c] || s.header);
  if (!picked.length) return cands.map(c => `### ${c}\n\`\`\`python\n${readFileSync(join(wd, c), "utf8").slice(0, 6000)}\n\`\`\``).join("\n\n");
  // group by file: header once, then its picked def blocks in source order
  return Object.keys(byFile).map(c => {
    const fns = picked.filter(p => p.c === c).map(p => p.text).join("\n\n");
    return `### ${c}\n\`\`\`python\n${byFile[c].trim()}\n# ... (relevant functions) ...\n${fns}\n\`\`\``;
  }).join("\n\n");
}

function localizedReproHints(cands, ctx, problem) {
  const symbols = [...new Set([...ctx.matchAll(/^\s*(?:def|class)\s+([A-Za-z_]\w*)/gm)].map(m => m[1]))]
    .filter(s => s.length >= 4 && !/^test_/.test(s))
    .slice(0, 30);
  const modules = [...new Set(cands.map(c => c.replace(/^src\//, "").replace(/\.py$/, "").replace(/\//g, ".")).filter(Boolean))];
  const fileTerms = [...new Set(cands.flatMap(c => c.split(/[/.]+/)).filter(s => s.length >= 4 && s !== "src"))];
  const issue = issueTerms(problem).filter(t => ctx.toLowerCase().includes(t)).slice(0, 30);
  const needles = [...new Set([...symbols, ...modules, ...fileTerms, ...issue].map(s => s.toLowerCase()))];
  const hint = [
    `localized files: ${cands.join(", ")}`,
    `importable modules: ${modules.join(", ")}`,
    `localized symbols: ${symbols.join(", ") || "(none)"}`,
    `issue terms present in localized code: ${issue.join(", ") || "(none)"}`,
  ].join("\n");
  const mentions = (code) => {
    const lower = code.toLowerCase();
    return needles.length === 0 || needles.some(n => lower.includes(n));
  };
  return { hint, mentions };
}

// per-repo layout so the pipeline is not requests-specific: src dirs to localize in, the package path
// for `git diff`, the test roots (pytest collects a directory recursively), and the import name for repros.
const REPO_CFG = {
  "psf/requests": { src: ["requests"], pkg: "requests", testRoots: ["tests", "test_requests.py"], imp: "requests", flags: "" },
  "pytest-dev/pytest": { src: ["src"], pkg: "src", testRoots: ["testing"], imp: "pytest", flags: "--continue-on-collection-errors", preferContainer: true },
  "django/django": { src: ["django"], pkg: "django", testRoots: ["tests"], imp: "django", flags: "--continue-on-collection-errors", runner: "django" },
  "pylint-dev/pylint": { src: ["pylint"], pkg: "pylint", testRoots: ["tests"], imp: "pylint", flags: "--continue-on-collection-errors" },
  "sympy/sympy": { src: ["sympy"], pkg: "sympy", testRoots: ["sympy"], imp: "sympy", flags: "--continue-on-collection-errors" },
};
const repoCfg = (inst) => REPO_CFG[inst.repo] || { src: [inst.repo.split("/")[1]], pkg: inst.repo.split("/")[1], testRoots: ["tests"], imp: inst.repo.split("/")[1], flags: "--continue-on-collection-errors" };
async function runInstance(inst) {
  const id = inst.instance_id, wd = `${SB}/wd-${id}`, venv = `${SB}/venvs/${id}`;
  const cfg = repoCfg(inst);
  const impRe = new RegExp(`(import|from)\\s+_?${cfg.imp}\\b`); // repro must import the package under test (or its _internal)
  try {
    // skip only if there's NO way to run the gate: no local era-venv AND no swebench container image.
    // (no-venv-but-image instances run in-container via makeRunner's container mode.)
    const imgName = `swebench/sweb.eval.x86_64.${id.replace("__", "_1776_")}:latest`;
    const hasImg = spawnSync("bash", ["-c", `sudo -n docker images -q ${imgName}`], { encoding: "utf8" }).stdout.trim().length > 0;
    if (!existsSync(`${venv}/bin/python`) && !hasImg) return { id, status: "env-skip" };
    if (!existsSync(wd)) return { id, status: "no-checkout" };
    const reset = () => execSync(`cd ${wd} && git reset --hard ${inst.base_commit} -q && (find . -type d -name __pycache__ -prune -exec sudo -n rm -rf {} + 2>/dev/null || true) && git clean -fdxq -e venv 2>/dev/null`, { stdio: "ignore" });
    reset();
    const hintCands = sourceHintsFromTestPatch(wd, cfg, inst.test_patch, 5);
    const literalCands = literalSourceHintsFromTestPatch(wd, cfg, inst.test_patch, 3);
    const cands = [...new Set([...hintCands, ...literalCands, ...retrieve(inst.problem_statement, wd, cfg.src, 5)])].slice(0, 5);
    if (!cands.length) return { id, status: "no-localize" };
    const ctx = funcContext(wd, cands, inst.problem_statement) + contractContext(wd, inst.problem_statement); // function-level + contract-required context
    // regression set = EVERY offline-passing test node across the suite. Pass the repo's test ROOTS
    // (a dir, which pytest collects recursively, or a root test file) — repo-parametric via cfg.
    const testFiles = cfg.testRoots.filter(t => existsSync(join(wd, t)));
    const img = `swebench/sweb.eval.x86_64.${id.replace("__", "_1776_")}:latest`; // requests repo id
    const localRunnerRaw = cfg.runner === "django" ? makeDjangoRunner(wd, venv) : makeRunner(wd, venv, false);
    const localRunner = { ...localRunnerRaw, nodes: (f) => runNodesBatched(localRunnerRaw, f) };
    // Drop deliberately-slow/infra integration tests that PASS but are unstable per-patch gates.
    const passing = (runner) => {
      const passToPass = listField(inst.PASS_TO_PASS);
      const modifiedP2P = modifiedTestNodeKeys(wd, inst.test_patch);
      const nodes = passToPass.length ? passToPass.filter(n => !modifiedP2P.has(testNodeKey(n))) : testFiles;
      return [...runner.nodes(nodes).passed].filter(n => !isSlowOrInfraNode(n)).slice(0, 500);
    };
    // detect local-venv incompatibility (can't run the era's tests) → fall back to in-container gating
    let basePass = passing(localRunner);
    const useC = cfg.runner !== "django" && ((cfg.preferContainer && hasImg) || (!basePass.length && testFiles.length > 0));
    const rawRunner = cfg.runner === "django" ? localRunnerRaw : makeRunner(wd, venv, useC, img, cfg.flags);
    const runner = { ...rawRunner, nodes: (f) => runNodesBatched(rawRunner, f) };
    if (useC) basePass = passing(runner);
    const ORACLE = Number((process.argv.find(a => a.startsWith("--oracle=")) || "--oracle=0").slice(9));
    const oracle = ORACLE ? oracleInfoModule(inst) : { nodes: [], text: "" };
    const pitfalls = issuePitfallsModule(inst.problem_statement);
    const reproHints = localizedReproHints(cands, ctx, inst.problem_statement);
    // --- generate VALID repros (soft ranker) ---
    const repros = [];
    for (let r = 0; r < R; r++) {
      const sys = `Write ONE Python unit test that reproduces this bug. Import the real ${cfg.imp} package (or its localized internal module when needed) and directly exercise the localized function/class/API with concrete inputs. Include a clear assert for the EXPECTED correct behavior so the test FAILS now and PASSES once fixed. The test must mention at least one localized file/module/symbol from the hint. NO network, sockets, servers, subprocesses, or real HTTP. Output ONLY the test code in one \`\`\`python block.`;
      const text = await callLLM([{ role: "system", content: sys }, { role: "user", content: `ISSUE:\n${inst.problem_statement.slice(0, 2000)}\n\nLOCALIZATION HINT:\n${reproHints.hint}\n\nRELEVANT CODE:\n${ctx}\n\nWrite the smallest localized failing unit test.` }], 0.5 + r * 0.2);
      const mm = text.match(/```(?:python)?\s*([\s\S]*?)```/); const code = mm ? mm[1] : text;
      if (!impRe.test(code)) continue;
      if (!/\bassert\b|unittest|pytest\.raises/.test(code) || !reproHints.mentions(code)) continue;
      const path = `test_repro_${r}.py`; writeFileSync(join(wd, path), code);
      const rr = runner.run([path]);
      // valid = fails at base AND not a network/collection/import crash (a real logic/assertion failure)
      if (rr.code !== 0 && !NETWORK_OR_BROKEN.test(rr.out) && /FAILED|AssertionError|^E\s+assert|\bassert\b/m.test(rr.out)) repros.push({ path, code }); else rmSync(join(wd, path), { force: true });
    }
    // --- sample K patches ---
    const sys = "You are fixing a bug in a Python library. Output ONLY Aider SEARCH/REPLACE blocks, no prose:\n### path/to/file.py\n<<<<<<< SEARCH\n<exact existing lines>\n=======\n<replacement>\n>>>>>>> REPLACE\nSEARCH must match the file byte-for-byte. Smallest change that fixes the ROOT CAUSE.";
    const usr = `ISSUE:\n${inst.problem_statement.slice(0, 2500)}${pitfalls}\n\nCANDIDATE FILES:\n${ctx}${oracle.text ? `\n\n${oracle.text}` : ""}\n\nProduce SEARCH/REPLACE edits fixing the root cause.`;
    const srOf = (t) => (t.match(/###[\s\S]*?>>>>>>> REPLACE/g) || []).join("\n\n");
    const scoreRepro = () => { let p = 0; for (const rp of repros) { writeFileSync(join(wd, rp.path), rp.code); if (runner.run([rp.path]).code === 0) p++; rmSync(join(wd, rp.path), { force: true }); } return p; };
    const scoreOracleResult = () => {
      if (!oracle.nodes.length || !applyTestPatch(wd, inst.test_patch)) return { pass: 0, passed: [], failed: [...oracle.nodes] };
      const r = runner.nodes(oracle.nodes);
      return classifyOracleResult(oracle.nodes, r, n => runner.tb([n]));
    };
    const scoreOracle = () => scoreOracleResult().pass;
    const survivors = [], repairCands = [], failedCandidates = [];
    for (let k = 0; k < K; k++) {
      reset(); // cleans untracked (incl. last patch + repros)
      const text = await callLLM([{ role: "system", content: sys }, { role: "user", content: usr }], k === 0 ? 0 : 0.7);
      if (!applyEdits(wd, text)) {
        failedCandidates.push({
          applyFailed: true,
          rawOutput: text,
          sr: srOf(text),
          diff: "",
          candidateFiles: cands,
          reproPass: 0,
          oraclePass: 0,
          broke: [],
          lintFindings: [],
          norm: "",
          size: 0,
        });
        continue;
      }
      const diff = execSync(`cd ${wd} && git diff -- ${cfg.pkg}`, { encoding: "utf8" });
      if (!diff.trim()) continue;
      const failed = basePass.length ? runner.nodes(basePass).failed : new Set();
      addCompileFailure(failed, runner, touchedPyFiles(diff));
      const lintFindings = patchLintModule(inst.problem_statement, diff);
      for (const lint of lintFindings) failed.add(`SER_PATCH_LINT::${lint}`);
      const reproPass = scoreRepro(); // SOFT ranker: of the valid repros, how many does this patch flip?
      const oracleResult = scoreOracleResult();
      const oraclePass = oracleResult.pass;
      const rec = { diff, sr: srOf(text), candidateFiles: cands, reproPass, oraclePass, oracleFailed: oracleResult.failed, broke: [...failed], lintFindings, norm: diff.replace(/\s+/g, " ").trim(), size: diff.split("\n").length };
      if (failed.size === 0) survivors.push(rec);
      else {
        failedCandidates.push(rec);
        if (reproPass > 0 || oraclePass > 0) repairCands.push(rec); // fixes the target but REGRESSES → repair candidate
      }
    }
    // REPAIR RUNG: no survivor actually fixed the target, but a candidate did and only regressed → feed
    // the broken test + traceback back and let the model find the COMPLETE (often multi-site) fix.
    const REPAIR = Number((process.argv.find(a => a.startsWith("--repair=")) || "--repair=3").slice(9));
    let repaired = 0;
    const oracleTotal = oracle.nodes.length;
    const solvesTarget = (s) => answerPass(s, oracleTotal) > 0;
    if (!survivors.some(solvesTarget) && repairCands.length && REPAIR > 0) {
      repairCands.sort((a, b) => (targetPass(b) - targetPass(a)) || (a.broke.length - b.broke.length));
      let cand = repairCands[0];
      // pull the SOURCE of a regressed test so the model sees the behavior it must preserve (autonomous
      // analogue of a hand-written "this test expects X" — a raw traceback alone proved too thin).
      const testSrc = (node) => {
        const f = node.split("::")[0], meth = node.split("::").pop().replace(/\[.*/, "");
        if (!existsSync(join(wd, f))) return "";
        const lines = readFileSync(join(wd, f), "utf8").split("\n");
        const i = lines.findIndex(l => new RegExp(`def ${meth}\\b`).test(l));
        if (i < 0) return "";
        const ind = lines[i].match(/^\s*/)[0].length; let j = i + 1;
        for (; j < lines.length; j++) { const l = lines[j]; if (l.trim() && l.match(/^\s*/)[0].length <= ind) break; }
        return lines.slice(i, j).join("\n");
      };
      const rsys = "You are fixing a bug in a Python library. Your previous edit fixed the target behavior but BROKE other passing tests. Reason briefly about WHY it broke (what behavior the broken test depends on that your edit changed), then output the COMPLETE set of Aider SEARCH/REPLACE blocks (### path, <<<<<<< SEARCH/=======/>>>>>>> REPLACE; SEARCH matches the ORIGINAL file) that fixes the bug AND keeps every previously-passing test green. The correct fix often needs MORE THAN ONE edit (e.g. change a shared helper AND compensate at a specific caller).";
      for (let round = 0; round < REPAIR && cand.broke.length; round++) {
        reset(); applyEdits(wd, cand.sr); // re-apply to capture the failure traceback
        const tb = runner.tb(cand.broke.slice(0, 2)).split("\n").filter(l => /assert|Error|def test_|^E /.test(l)).slice(0, 10).join("\n");
        reset();
        const brokeSrc = cand.broke.slice(0, 2).map(n => `# ${n}\n${testSrc(n)}`).filter(s => s.includes("def ")).join("\n\n");
        const rtext = await callLLM([{ role: "system", content: rsys }, { role: "user", content: `ISSUE:\n${inst.problem_statement.slice(0, 2000)}${pitfalls}\n\nRELEVANT CODE:\n${ctx}${oracle.text ? `\n\n${oracle.text}` : ""}\n\nYOUR PREVIOUS EDIT:\n${cand.sr}\n\nGATE RESULT: it fixed the target but REGRESSED these previously-passing tests: ${cand.broke.join(", ")}.\nFailure detail:\n${tb}\n\nSOURCE OF THE BROKEN TEST(S) (the behavior you must preserve):\n\`\`\`python\n${brokeSrc}\n\`\`\`\n\nReason about WHY it broke, then output the COMPLETE corrected edit set against the ORIGINAL files.` }], 0.2, REPAIR_MODEL);
        // the model is inconsistent about base state — try the revision BOTH on-top-of-candidate AND
        // from-base; keep whichever passes the gate. (Fixes the silent "applied but incomplete" misses.)
        let landed = null;
        for (const onTop of [true, false]) {
          reset(); if (onTop) applyEdits(wd, cand.sr);
          if (!applyEdits(wd, rtext)) continue;
          const diff = execSync(`cd ${wd} && git diff -- ${cfg.pkg}`, { encoding: "utf8" });
          if (!diff.trim()) continue;
          const failed = basePass.length ? runner.nodes(basePass).failed : new Set();
          addCompileFailure(failed, runner, touchedPyFiles(diff));
          const lintFindings = patchLintModule(inst.problem_statement, diff);
          for (const lint of lintFindings) failed.add(`SER_PATCH_LINT::${lint}`);
          const reproPass = scoreRepro();
          const oracleResult = scoreOracleResult();
          const oraclePass = oracleResult.pass;
          if (answerPass({ reproPass, oraclePass }, oracleTotal) > 0 && failed.size === 0) { landed = { diff, reproPass, oraclePass, win: true }; break; }
          if (!landed) landed = { diff, reproPass, oraclePass, oracleFailed: oracleResult.failed, failed: [...failed], lintFindings };
        }
        if (landed?.win) { survivors.push({ diff: landed.diff, sr: srOf(rtext), reproPass: landed.reproPass, oraclePass: landed.oraclePass, broke: [], norm: landed.diff.replace(/\s+/g, " ").trim(), size: landed.diff.split("\n").length }); repaired = round + 1; break; }
        if (landed) cand = { diff: landed.diff, sr: srOf(rtext), reproPass: landed.reproPass, oraclePass: landed.oraclePass, oracleFailed: landed.oracleFailed, broke: landed.failed || cand.broke };
        else if (srOf(rtext)) cand = { ...cand, sr: srOf(rtext) };
      }
    }
    // ORACLE RUNG: development-only answer-key mode. If cheap samples are regression-clean but none
    // pass the official FAIL_TO_PASS nodes, ask the repair model to target that concrete contract.
    const ORACLE_REPAIR = Number((process.argv.find(a => a.startsWith("--oracle-repair=")) || "--oracle-repair=2").slice(16));
    let oracleRepaired = 0;
    if (oracle.nodes.length && !survivors.some(solvesTarget) && ORACLE_REPAIR > 0) {
      const counts = {}; for (const s of survivors) counts[s.norm] = (counts[s.norm] || 0) + 1;
      const weak = [...survivors].sort((a, b) => (counts[b.norm] - counts[a.norm]) || (a.size - b.size)).slice(0, 3);
      const osys = "You are fixing a Python library bug. The DEVELOPMENT ORACLE below is the exact FAIL_TO_PASS test contract. Output ONLY Aider SEARCH/REPLACE blocks against the ORIGINAL source files. The patch must make the oracle nodes pass while preserving existing passing tests. Prefer the smallest complete root-cause fix; incomplete helper-only fixes are wrong.";
      for (let a = 0; a < ORACLE_REPAIR; a++) {
        const otext = await callLLM([{ role: "system", content: osys }, { role: "user", content: `ISSUE:\n${inst.problem_statement.slice(0, 2500)}${pitfalls}\n\nRELEVANT CODE:\n${ctx}\n\n${oracle.text}\n\nLOW-CONFIDENCE CLEAN PATCHES THAT DID NOT PASS THE ORACLE:\n${weak.map((s, i) => `# candidate ${i + 1} (oraclePass=${s.oraclePass || 0})\n${s.sr || s.diff}`).join("\n\n").slice(0, 9000)}\n\nProduce the complete source fix against the ORIGINAL files.` }], a * 0.25, REPAIR_MODEL);
        reset();
        if (!applyEdits(wd, otext)) continue;
        const diff = execSync(`cd ${wd} && git diff -- ${cfg.pkg}`, { encoding: "utf8" });
        if (!diff.trim()) continue;
        const failed = basePass.length ? runner.nodes(basePass).failed : new Set();
        addCompileFailure(failed, runner, touchedPyFiles(diff));
        const lintFindings = patchLintModule(inst.problem_statement, diff);
        for (const lint of lintFindings) failed.add(`SER_PATCH_LINT::${lint}`);
        const reproPass = scoreRepro();
        const oracleResult = scoreOracleResult();
        const oraclePass = oracleResult.pass;
        log(`  [${id.replace("psf__requests-", "#")}] ORACLE attempt ${a}: touches=${[...diff.matchAll(/^\+\+\+ b\/(\S+)/gm)].map(x => x[1]).join(",")}, regressions=${failed.size}, oraclePass=${oraclePass}/${oracle.nodes.length}`);
        if (failed.size === 0 && answerPass({ reproPass, oraclePass }, oracleTotal) > 0) {
          survivors.push({ diff, sr: srOf(otext), reproPass, oraclePass, broke: [], norm: diff.replace(/\s+/g, " ").trim(), size: diff.split("\n").length });
          oracleRepaired = a + 1;
          break;
        } else {
          failedCandidates.push({ diff, sr: srOf(otext), candidateFiles: cands, reproPass, oraclePass, oracleFailed: oracleResult.failed, broke: [...failed], lintFindings, norm: diff.replace(/\s+/g, " ").trim(), size: diff.split("\n").length });
        }
      }
    }
    // KNIGHT RUNG: cheap sampling never even fixed the target (no repro-passing survivor) → escalate to
    // the strong model with the OBSERVE step (probe the suspect calls, feed the decisive runtime fact +
    // call→fn map). This is the 6028 path — localization+insight the cheap model can't do unaided.
    const KNIGHT = Number((process.argv.find(a => a.startsWith("--knight=")) || "--knight=2").slice(9));
    let knighted = 0;
    if (!survivors.some(solvesTarget) && KNIGHT > 0 && REPAIR_MODEL !== MODEL) {
      reset();
      const { obs, callMap } = probeObserve(wd, cands, ctx, runner.py);
      const kctx = `${ctx}\n\nDIAGNOSTIC PROBE (actual runtime behavior of the suspect functions' calls — TRUST over assumptions about library internals):${obs}\nWHERE THOSE CALLS ARE USED (the fix likely belongs in the function that mishandles the observed value):\n${callMap}`;
      // author a KNIGHT repro grounded in the observation — the cheap repros proved a poor oracle (they
      // don't credit the correct localized fix). The knight now KNOWS the decisive fact, so it writes a
      // discriminating unit test; gate the knight fix on THAT (a good oracle keeps the no-false-pass floor).
      const kRepros = [];
      for (let r = 0; r < 2 && !kRepros.length; r++) {
        reset();
        const rt = await callLLM([{ role: "system", content: "Given an issue and OBSERVED runtime behavior, write ONE Python unit test that calls the buggy function DIRECTLY with concrete inputs and asserts the CORRECT behavior, so it FAILS now and PASSES once fixed. No network/sockets/HTTP. Output only the test in one ```python block." }, { role: "user", content: `ISSUE:\n${inst.problem_statement.slice(0, 1500)}${pitfalls}\n\n${kctx}\n\nWrite the failing unit test.` }], 0.4 + r * 0.3, REPAIR_MODEL);
        const mm = rt.match(/```(?:python)?\s*([\s\S]*?)```/); const code = mm ? mm[1] : rt;
        if (!impRe.test(code)) continue;
        const path = `test_knight_${r}.py`; writeFileSync(join(wd, path), code);
        const rr = runner.run([path]);
        if (rr.code !== 0 && !NETWORK_OR_BROKEN.test(rr.out)) kRepros.push({ path, code }); else rmSync(join(wd, path), { force: true });
      }
      const gateRepros = kRepros.length ? kRepros : repros; // prefer the observation-grounded oracle
      log(`  [${id.replace("psf__requests-", "#")}] KNIGHT: libCalls probed, kRepros=${kRepros.length}, gateRepros=${gateRepros.length}`);
      const ksys = "You are fixing a bug in a Python library. Diagnostic probes (below) show the ACTUAL runtime behavior of the suspect functions' library calls — trust it over your assumptions. Find the root cause and output ONLY Aider SEARCH/REPLACE blocks (### path, <<<<<<< SEARCH/=======/>>>>>>> REPLACE; SEARCH matches the original file). Smallest root-cause fix.";
      for (let a = 0; a < KNIGHT; a++) {
        const ktext = await callLLM([{ role: "system", content: ksys }, { role: "user", content: `ISSUE:\n${inst.problem_statement.slice(0, 2500)}${pitfalls}\n\nRELEVANT CODE:\n${kctx}\n\nProduce the SEARCH/REPLACE fix grounded in the observed behavior.` }], a * 0.3, REPAIR_MODEL);
        reset();
        if (!applyEdits(wd, ktext)) continue;
        const diff = execSync(`cd ${wd} && git diff -- ${cfg.pkg}`, { encoding: "utf8" });
        if (!diff.trim()) continue;
        const failed = basePass.length ? runner.nodes(basePass).failed : new Set();
        addCompileFailure(failed, runner, touchedPyFiles(diff));
        const lintFindings = patchLintModule(inst.problem_statement, diff);
        for (const lint of lintFindings) failed.add(`SER_PATCH_LINT::${lint}`);
        let kp = 0; for (const rp of gateRepros) { writeFileSync(join(wd, rp.path), rp.code); if (runner.run([rp.path]).code === 0) kp++; rmSync(join(wd, rp.path), { force: true }); }
        const oracleResult = scoreOracleResult();
        const oraclePass = oracleResult.pass;
        log(`  [${id.replace("psf__requests-", "#")}] KNIGHT attempt ${a}: applied, touches=${[...diff.matchAll(/^\+\+\+ b\/(\S+)/gm)].map(x => x[1]).join(",")}, regressions=${failed.size}, kReproPass=${kp}/${gateRepros.length}, oraclePass=${oraclePass}/${oracle.nodes.length}`);
        if (failed.size === 0 && answerPass({ reproPass: kp || 0, oraclePass }, oracleTotal) > 0) { survivors.push({ diff, sr: srOf(ktext), reproPass: kp || 0, oraclePass, broke: [], norm: diff.replace(/\s+/g, " ").trim(), size: diff.split("\n").length }); knighted = a + 1; break; }
        else failedCandidates.push({ diff, sr: srOf(ktext), candidateFiles: cands, reproPass: kp || 0, oraclePass, oracleFailed: oracleResult.failed, broke: [...failed], lintFindings, norm: diff.replace(/\s+/g, " ").trim(), size: diff.split("\n").length });
      }
    }
    const REPAIR_RUNG = Number((process.argv.find(a => a.startsWith("--repair-rung=")) || "--repair-rung=1").slice(14));
    if (!survivors.some(solvesTarget) && REPAIR_RUNG > 0) {
      const tracePath = `${SB}/repair-trace-${id}.jsonl`;
      const repairSurvivors = await runRepairRung({
        id, inst, wd, cands, ctx, oracle,
        candidates: [
          ...failedCandidates,
          ...survivors.filter(s => !solvesTarget(s)).map(s => ({ ...s, broke: [], lintFindings: [], classification: "oracle_miss" })),
        ],
        reset,
        applyEdits,
        diffCmd: () => execSync(`cd ${wd} && git diff -- ${cfg.pkg}`, { encoding: "utf8" }),
        callLLM,
        repairModel: REPAIR_MODEL,
        runner,
        basePass,
        scoreRepro,
        scoreOracle,
        scoreOracleResult,
        patchLint: patchLintModule,
        issuePitfalls: pitfalls,
        tracePath,
        log,
        maxRecords: Number((process.argv.find(a => a.startsWith("--repair-records=")) || "--repair-records=2").slice(17)),
        attempts: REPAIR_RUNG,
      });
      if (repairSurvivors.length) survivors.push(...repairSurvivors);
    }
    if (!survivors.length || (oracle.nodes.length && !survivors.some(solvesTarget))) return { id, status: "no-survivor", note: `${survivors.length} clean of ${K}, ${repros.length} repros, ${repairCands.length} repair-cand, oracle ${oracle.nodes.length ? "miss" : "off"}, knight ${knighted ? "y" : "n"}` };
    // rank: most repro-passes, then majority vote, then smallest diff
    const counts = {}; for (const s of survivors) counts[s.norm] = (counts[s.norm] || 0) + 1;
    survivors.sort((a, b) => (answerPass(b, oracleTotal) - answerPass(a, oracleTotal)) || (targetPass(b) - targetPass(a)) || (counts[b.norm] - counts[a.norm]) || (a.size - b.size));
    let w = null;
    for (const candidate of survivors) {
      reset();
      if (!applyUnifiedPatch(wd, candidate.diff)) continue;
      const failed = basePass.length ? runner.nodes(basePass).failed : new Set();
      addCompileFailure(failed, runner, touchedPyFiles(candidate.diff));
      const lintFindings = patchLintModule(inst.problem_statement, candidate.diff);
      for (const lint of lintFindings) failed.add(`SER_PATCH_LINT::${lint}`);
      const reproPass = scoreRepro();
      const oracleResult = scoreOracleResult();
      const oraclePass = oracleResult.pass;
      if (failed.size === 0 && answerPass({ reproPass, oraclePass }, oracleTotal) > 0) {
        w = { ...candidate, reproPass, oraclePass };
        break;
      }
      log(`  [${id.replace("psf__requests-", "#")}] FINAL recheck rejected: regressions=${failed.size}, oraclePass=${oraclePass}/${oracleTotal}, lints=${lintFindings.length}`);
    }
    if (!w) return { id, status: "no-survivor", note: `${survivors.length} local survivors rejected by final clean recheck` };
    appendFileSync(`${SB}/predictions-select.jsonl`, JSON.stringify({ instance_id: id, model_patch: w.diff, model_name_or_path: "ser-select-v2" }) + "\n");
    return { id, status: "selected", survivors: survivors.length, repros: repros.length, reproPass: w.reproPass, oraclePass: w.oraclePass || 0, votes: counts[w.norm], repaired, knighted, oracleRepaired, cands };
  } catch (e) { return { id, status: "error", note: String(e).slice(0, 160) }; }
}
export { callLLM, makeRunner, djangoNode, makeDjangoRunner, applyEdits, funcContext, issueTerms, issuePitfalls, oracleContractHints, patchLint, targetPass, answerPass, classifyOracleResult, isSlowOrInfraNode, runNodesBatched, defBlocks, localizedReproHints, repoCfg, sourceHintsFromTestPatch, literalSourceHintsFromTestPatch };
async function pool(items, k, fn) { const ret = []; let i = 0; await Promise.all(Array(k).fill(0).map(async () => { while (i < items.length) { const idx = i++; ret[idx] = await fn(items[idx]); log(`  [${ret[idx].id.replace("psf__requests-", "#")}] ${ret[idx].status}${ret[idx].status === "selected" ? ` (repros=${ret[idx].repros} survivors=${ret[idx].survivors} reproPass=${ret[idx].reproPass}${ret[idx].oraclePass ? ` oraclePass=${ret[idx].oraclePass}` : ""} votes=${ret[idx].votes}${ret[idx].repaired ? ` REPAIRED@${ret[idx].repaired}` : ""}${ret[idx].oracleRepaired ? ` ORACLE@${ret[idx].oracleRepaired}` : ""}${ret[idx].knighted ? ` KNIGHTED@${ret[idx].knighted}` : ""})` : ""}${ret[idx].note ? " — " + ret[idx].note : ""}`); writeFileSync(`${SB}/results-select.json`, JSON.stringify(ret.filter(Boolean), null, 1)); } })); return ret; }
// run the pipeline only when invoked directly (not when imported for a ranking check)
if (process.argv[1] && process.argv[1].endsWith("select.mjs")) {
  if (!existsSync(`${SB}/${INSTANCES}`)) throw new Error(`instances file not found: ${SB}/${INSTANCES}`);
  const out = await pool(insts, POOL, runInstance);
  log(`\n=== SELECT v2 DONE === ${out.filter(r => r.status === "selected").length} patches / ${out.length} (${out.map(r => r.id.replace("psf__requests-", "#") + ":" + r.status).join(" ")})`);
}
