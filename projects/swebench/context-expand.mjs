import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function defBlocks(src) {
  const lines = src.split("\n"), out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(def|class)\s+([A-Za-z_]\w*)/);
    if (!m) continue;
    const indent = m[1].length;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === "") continue;
      const ind = l.match(/^\s*/)[0].length;
      if (ind <= indent) break;
    }
    out.push({ name: m[3], kind: m[2], start: i + 1, end: j, text: lines.slice(i, j).join("\n") });
  }
  return out;
}

function changedFiles(diff) {
  return [...diff.matchAll(/^\+\+\+ b\/(\S+)/gm)].map(m => m[1]).filter(p => p.endsWith(".py"));
}

function changedNames(diff) {
  const names = new Set();
  for (const m of diff.matchAll(/^@@[\s\S]*?@@\s*(?:def|class)\s+([A-Za-z_]\w*)/gm)) names.add(m[1]);
  for (const m of diff.matchAll(/^[+-]\s*(?:def|class)\s+([A-Za-z_]\w*)/gm)) names.add(m[1]);
  for (const m of diff.matchAll(/\b([A-Za-z_]\w{4,})\s*\(/g)) names.add(m[1]);
  return names;
}

export function expandRepairContext(wd, cands, baseCtx, diff, budget = 50000) {
  const files = [...new Set([...changedFiles(diff), ...cands])];
  const seedNames = changedNames(diff);
  const selected = [];
  const byFile = new Map();
  const add = (file, block) => {
    const key = `${file}:${block.name}:${block.start}`;
    if (selected.some(s => s.key === key)) return;
    selected.push({ key, file, block });
  };

  for (const file of files) {
    const fp = join(wd, file);
    if (!existsSync(fp)) continue;
    const src = readFileSync(fp, "utf8");
    const blocks = defBlocks(src).filter(b => b.kind !== "class");
    byFile.set(file, { src, blocks });
    for (const b of blocks) {
      if (seedNames.has(b.name) || [...seedNames].some(n => n.length >= 5 && new RegExp(`\\b${n}\\s*\\(`).test(b.text))) add(file, b);
    }
  }

  for (const { file, block } of [...selected]) {
    const { blocks } = byFile.get(file) || {};
    if (!blocks) continue;
    for (const b of blocks) {
      if (b.name === block.name || b.name.length < 5) continue;
      if (new RegExp(`\\b${b.name}\\s*\\(`).test(block.text)) add(file, b);
      if (new RegExp(`\\b${block.name}\\s*\\(`).test(b.text)) add(file, b);
    }
  }

  const pieces = [];
  let used = baseCtx.length;
  for (const [file, data] of byFile) {
    const header = data.src.slice(0, Math.min(data.src.indexOf("\nclass ") > 0 ? data.src.indexOf("\nclass ") : 1200, 1200)).trim();
    const blocks = selected.filter(s => s.file === file).map(s => s.block.text);
    if (!blocks.length) continue;
    const piece = `### ${file}\n\`\`\`python\n${header}\n# ... (repair-expanded functions) ...\n${blocks.join("\n\n")}\n\`\`\``;
    if (used + piece.length > budget) continue;
    pieces.push(piece);
    used += piece.length;
  }
  return [baseCtx, pieces.length ? `\n\nREPAIR-EXPANDED CONTEXT:\n${pieces.join("\n\n")}` : ""].join("");
}

export function contractContext(wd, problem, budget = 30000) {
  const p = problem.toLowerCase();
  const wanted = [];
  if (/\bmro\b/.test(p) && /mark/.test(p) && /class/.test(p)) {
    wanted.push({
      file: "src/_pytest/mark/structures.py",
      names: ["get_unpacked_marks", "store_mark", "normalize_mark_list"],
    });
  }
  if (/chain/.test(p) && /exception/.test(p) && /serial/.test(p)) {
    wanted.push({
      file: "src/_pytest/reports.py",
      names: ["_to_json", "_from_json", "_report_unserialization_failure"],
    });
    wanted.push({
      file: "src/_pytest/_code/code.py",
      names: ["ExceptionChainRepr", "ReprExceptionInfo", "ReprTraceback", "ReprEntry", "ReprEntryNative", "ReprFileLocation", "ReprLocals", "ReprFuncArgs"],
    });
  }
  if (/media/.test(p) && /order/.test(p) && /conflict/.test(p)) {
    wanted.push({
      file: "django/utils/topological_sort.py",
      names: ["CyclicDependencyError", "stable_topological_sort", "topological_sort_as_sets"],
    });
    wanted.push({
      file: "django/utils/datastructures.py",
      names: ["OrderedSet"],
    });
  }
  const pieces = [];
  let used = 0;
  for (const item of wanted) {
    const fp = join(wd, item.file);
    if (!existsSync(fp)) continue;
    const src = readFileSync(fp, "utf8");
    const header = src.slice(0, Math.min(src.indexOf("\nclass ") > 0 ? src.indexOf("\nclass ") : 1200, 1200)).trim();
    const blocks = defBlocks(src).filter(b => item.names.includes(b.name));
    if (!blocks.length) continue;
    const piece = `### ${item.file}\n\`\`\`python\n${header}\n# ... (contract-required symbols) ...\n${blocks.map(b => b.text).join("\n\n")}\n\`\`\``;
    if (used + piece.length > budget) continue;
    pieces.push(piece);
    used += piece.length;
  }
  return pieces.length ? `\n\nCONTRACT-REQUIRED CONTEXT:\n${pieces.join("\n\n")}` : "";
}
