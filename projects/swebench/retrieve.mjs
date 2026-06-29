import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const STOP = new Set(
  "http https this that with from import self none true false return class should would which when result actual expected steps system information version thanks submitting contribution really appreciated quick checklist include documentation adding features tests update existing applicable allow maintainers push squash merging commits uncheck prefer yourself change fixes please text like closes description where number github docs help managing work linking pull request keyword unless trivial small typo reword section create changelog file folder name issue type readme blob main details write sentences past tense examples improved verbose diff output sequences terminal summary statistics colors also make sentence authors alphabetical order the and for are but been have into only each other using well still because sure ever just more without pass test valueerror exception exceptions python raise except basic chain chained handling above occurred direct cause following".split(" ")
);

function cleanProblem(problem) {
  return problem
    .replace(/<!--[\s\S]*?-->/g, " ")
    .split(/Thanks for submitting|Here's a quick checklist|Create a changelog/i)[0];
}

function tokenPieces(word) {
  const w = word.toLowerCase();
  const out = [];
  if (w.length > 2) out.push(w);
  for (const p of w.split(/[_./]+/)) if (p.length > 2) out.push(p);
  if (w.length >= 7) out.push(w.slice(0, 6));
  return out.filter(t => !STOP.has(t));
}

function addQueryTerm(map, word, weight) {
  for (const t of tokenPieces(word)) map.set(t, (map.get(t) || 0) + weight);
}

function queryTerms(problem) {
  const p = cleanProblem(problem);
  const terms = new Map();
  const title = p.split("\n").find(l => l.trim()) || "";
  for (const m of title.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) addQueryTerm(terms, m[0], 10);
  for (const m of p.matchAll(/`([^`]+)`|'([^']+)'|"([^"]+)"/g)) {
    for (const w of (m[1] || m[2] || m[3]).matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) addQueryTerm(terms, w[0], 4);
  }
  for (const m of p.matchAll(/```[\s\S]*?```/g)) {
    for (const w of m[0].matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) addQueryTerm(terms, w[0], 0.5);
  }
  for (const m of p.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) addQueryTerm(terms, m[0], 1);
  return terms;
}

export function listPyFiles(root, dirs) {
  const out = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n);
    if (n === "__pycache__" || n.startsWith(".") || n === "tests" || n === "testing") continue;
    const s = statSync(p); if (s.isDirectory()) walk(p); else if (n.endsWith(".py")) out.push(p); } };
  for (const dir of dirs) { try { walk(join(root, dir)); } catch {} }
  return out;
}
export function retrieve(problem, root, srcDirs, topN = 3) {
  // distinctive weighted tokens from the problem. Title/backtick/code identifiers are stronger than
  // prose, while issue-template boilerplate is ignored so it does not swamp the bug signal.
  const toks = queryTerms(problem);
  // explicit file paths named in the problem (e.g. requests/models.py)
  const named = [...new Set((problem.match(/[\w/]+\.py/g) || []))];
  const files = listPyFiles(root, srcDirs);
  // BM25: raw token COUNT (the old scoring) is biased to BIG files — they accumulate more matches just
  // by size, so on large repos (pytest) it always returned python.py/fixtures.py regardless of the bug.
  // BM25 fixes this: IDF down-weights tokens common across files; length-normalization removes the
  // big-file bias. (Project localization research: BM25 beats embeddings + agentic localizers.)
  const docs = files.map(f => {
    let body = ""; try { body = readFileSync(f, "utf8"); } catch {}
    const rel = f.slice(root.length + 1);
    const terms = [];
    for (const m of body.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) terms.push(...tokenPieces(m[0]));
    for (const m of rel.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) for (let i = 0; i < 16; i++) terms.push(...tokenPieces(m[0]));
    for (const m of body.matchAll(/^\s*(?:def|class)\s+([A-Za-z_]\w*)/gm)) for (let i = 0; i < 16; i++) terms.push(...tokenPieces(m[1]));
    const tf = Object.create(null); for (const w of terms) tf[w] = (tf[w] || 0) + 1;
    return { rel, tf, len: terms.length || 1 };
  });
  const N = docs.length || 1;
  const avgdl = docs.reduce((s, d) => s + d.len, 0) / N;
  const df = Object.create(null); for (const t of toks.keys()) df[t] = docs.reduce((c, d) => c + (d.tf[t] ? 1 : 0), 0);
  const k1 = 1.5, b = 0.75;
  const scored = docs.map(d => {
    let score = 0;
    for (const [t, weight] of toks) {
      const f = d.tf[t] || 0; if (!f) continue;
      const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
      score += weight * idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / avgdl));
    }
    if (named.some(n => d.rel.endsWith(n))) score += 100000; // explicit path mention dominates
    return { rel: d.rel, score };
  }).sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).filter(x => x.score > 0).map(x => x.rel);
}
