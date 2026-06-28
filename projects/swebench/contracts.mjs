export function listField(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const j = JSON.parse(v);
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function oracleContractHints(testPatch = "") {
  const hints = [];
  if (/def test_mark_mro/.test(testPatch)) {
    hints.push("- get_unpacked_marks(C) must return marks in class-first MRO order: C, then A, then B.");
    hints.push("- get_unpacked_marks must return a concrete list of Mark objects, not a generator.");
    hints.push("- get_unpacked_marks(C, consider_mro=False) must return only C's direct pytestmark.");
    hints.push("- The direct-only path for class objects must read obj.__dict__.get(\"pytestmark\", []), not getattr(obj, \"pytestmark\", []).");
    hints.push("- Existing mark storage/decorator code must keep using direct marks only, not inherited marks.");
    hints.push("- A complete fix should update the mark-storage caller (store_mark) to request direct-only unpacking, e.g. by passing the new direct-only option there.");
  }
  if (/def test_chained_exceptions/.test(testPatch)) {
    hints.push("- _to_json/_from_json must round-trip longrepr objects that are ExceptionChainRepr.");
    hints.push("- Serialized longrepr must preserve the existing top-level reprtraceback, reprcrash, and sections keys for backward compatibility; add chain in addition to those keys, not instead of them.");
    hints.push("- During deserialization, validate the existing top-level reprtraceback entries before or while handling chain, so unknown entry types still raise _report_unserialization_failure.");
    hints.push("- The fix belongs in the shared BaseReport serialization/deserialization path, not a CollectReport-only override.");
    hints.push("- The serialized chain must preserve each tuple: repr_traceback, repr_crash/fileloc, and description.");
    hints.push("- Deserialization must reconstruct ExceptionChainRepr so isinstance(longrepr, ExceptionChainRepr), sections, chain length, descriptions, and toterminal() all work for both TestReport and CollectReport.");
    hints.push("- Existing deserialization failure behavior for unknown reprentry types must still raise the original RuntimeError.");
  }
  return hints.join("\n");
}

export function oracleInfo(inst) {
  const nodes = listField(inst.FAIL_TO_PASS);
  if (!nodes.length || !inst.test_patch) return { nodes: [], text: "" };
  const contract = oracleContractHints(inst.test_patch);
  return {
    nodes,
    text: `DEVELOPMENT ORACLE (official FAIL_TO_PASS tests; use only for harness debugging, not blind benchmark claims):\nNodes that must pass after the fix:\n${nodes.map(n => `- ${n}`).join("\n")}${contract ? `\n\nBehavioral contract extracted from the test patch:\n${contract}` : ""}\n\nTest patch defining the target behavior:\n\`\`\`diff\n${inst.test_patch.slice(0, 12000)}\n\`\`\``,
  };
}

export function issuePitfalls(problem) {
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
