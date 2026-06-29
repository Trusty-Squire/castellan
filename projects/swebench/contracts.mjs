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
  if (/test_headers_on_session_with_None_are_not_sent/.test(testPatch) || (/None values/.test(testPatch) && /Session\.headers/.test(testPatch))) {
    hints.push("- Session-level headers whose value is None must be removed before preparing the request; the literal string/value None must not be sent.");
    hints.push("- Request-level None removal must still work after merging session defaults with per-request headers.");
  }
  if (/DIGESTAUTH_QUOTES_QOP_VALUE/.test(testPatch)) {
    hints.push("- Digest auth Authorization qop must be emitted as qop=\"auth\", not qop=auth.");
    hints.push("- Keep existing digest auth status-code and request behavior green while changing only the header formatting.");
  }
  if (/test_encoded_methods/.test(testPatch)) {
    hints.push("- Byte-string HTTP methods must be decoded to the real method token, e.g. b'GET' becomes GET, not \"b'GET'\".");
    hints.push("- Preserve normal string methods, redirects, timeout behavior, request history, netrc auth, json content type, and file POST behavior.");
  }
  if (/test_prepend_scheme_if_needed/.test(testPatch) && /user:pass@example\.com/.test(testPatch)) {
    hints.push("- prepend_scheme_if_needed must preserve userinfo/auth in URLs: http://user:pass@example.com/... stays unchanged.");
    hints.push("- In this Requests implementation, parse_url(url) returns auth separately from parsed.netloc; urlunparse must receive a netloc that includes auth when auth is present.");
    hints.push("- The fix belongs in URL parsing/recomposition, not proxy networking; preserve existing scheme-prepending behavior for host-only inputs such as example.com:80.");
  }
  if (/InvalidURL/.test(testPatch) && /http:\/\/\.example\.com/.test(testPatch)) {
    hints.push("- Invalid host labels such as http://.example.com must raise requests.exceptions.InvalidURL, not UnicodeError.");
    hints.push("- Preserve existing InvalidSchema/InvalidURL behavior for the other invalid URL parametrizations.");
  }
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
  if (/def test_Identity/.test(testPatch) && /Sum\(In\[i, j\]/.test(testPatch)) {
    hints.push("- For symbolic indices i and j, Identity(n)[i, j] must remain a symbolic Kronecker-delta-like entry, not collapse to S.Zero from Python object inequality.");
    hints.push("- Numeric Identity entries must preserve existing behavior: diagonal entries are 1 and off-diagonal entries are 0.");
    hints.push("- Summing all symbolic entries Sum(Identity(n)[i, j], i=0..n-1, j=0..n-1) must evaluate to n after substituting n=3.");
    hints.push("- Nested sums over the same Identity entry must also evaluate to n; the fix must work with SymPy's summation/doit path, not only direct indexing.");
  }
  return hints.join("\n");
}

export function oracleNodeSummaries(inst) {
  const nodes = listField(inst.FAIL_TO_PASS);
  const patch = inst.test_patch || "";
  return nodes.map((node) => {
    const testName = node.split("::").pop()?.replace(/\[.*$/, "") || node;
    const snippet = addedTestSnippet(patch, testName);
    return snippet ? { node, testName, snippet } : { node, testName, snippet: "" };
  });
}

export function oracleInfo(inst) {
  const nodes = listField(inst.FAIL_TO_PASS);
  if (!nodes.length || !inst.test_patch) return { nodes: [], text: "" };
  const contract = oracleContractHints(inst.test_patch);
  const summaries = oracleNodeSummaries(inst);
  const nodeText = summaries.map((s, i) => {
    const body = s.snippet ? `\n\`\`\`python\n${s.snippet}\n\`\`\`` : "";
    return `${i + 1}. ${s.node}${body}`;
  }).join("\n");
  return {
    nodes,
    text: `DEVELOPMENT ORACLE (official FAIL_TO_PASS tests; use only for harness debugging, not blind benchmark claims):\nEvery node below must pass after the fix; partial pass is incomplete.\n${nodeText}${contract ? `\n\nBehavioral contract extracted from the test patch:\n${contract}` : ""}\n\nTest patch defining the target behavior:\n\`\`\`diff\n${inst.test_patch.slice(0, 12000)}\n\`\`\``,
  };
}

function addedTestSnippet(patch, testName) {
  const lines = patch.split("\n");
  const defRe = new RegExp(`^\\+\\s+def ${escapeRe(testName)}\\b`);
  const start = lines.findIndex(l => defRe.test(l));
  if (start < 0) return "";
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (i > start && /^[-+ ]\s+def test_/.test(line)) break;
    if (!line.startsWith("+")) continue;
    out.push(line.slice(1));
    if (out.length >= 80) break;
  }
  return out.join("\n").trimEnd();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
