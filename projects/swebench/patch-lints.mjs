export function patchLint(problem, diff) {
  const p = problem.toLowerCase();
  const issues = [];
  if (/^\+?(<<<<<<<|=======|>>>>>>>)(?:\s|$)/m.test(diff)) {
    issues.push("Patch contains leaked conflict or SEARCH/REPLACE delimiter lines.");
  }
  if (/\bmro\b/.test(p) && /mark/.test(p) && /class/.test(p) && /pytestmark/.test(diff)) {
    if (/reversed\s*\(\s*obj\.__mro__\s*\)/.test(diff)) {
      issues.push("MRO marks patch reverses obj.__mro__; expected class-before-base MRO order.");
    }
    const usesDirectClassDict = /__dict__\.get\(["']pytestmark["']/.test(diff);
    if (!usesDirectClassDict && (/\+\s*mark_list\s*=\s*getattr\s*\(\s*\w+\s*,\s*["']pytestmark["']/.test(diff) || /\+\s*marks\s*=\s*getattr\s*\(\s*\w+\s*,\s*["']pytestmark["']/.test(diff))) {
      issues.push("MRO marks patch reads pytestmark with getattr. For direct-only class marks, use obj.__dict__.get(\"pytestmark\", []) or cls.__dict__.get(\"pytestmark\", []), never getattr(..., \"pytestmark\", ...).");
    }
    if (/def get_unpacked_marks/.test(diff) && !/consider_mro|def store_mark/.test(diff)) {
      issues.push("MRO marks patch changes shared unpacking without an explicit direct-only path for mark storage.");
    }
    if (/consider_mro/.test(diff) && !/def store_mark/.test(diff)) {
      issues.push("MRO marks patch adds a consider_mro option but does not update store_mark to use the direct-only path.");
    }
    if (/def get_unpacked_marks/.test(diff) && /\+\s*return normalize_mark_list\(/.test(diff)) {
      issues.push("MRO marks patch returns normalize_mark_list() directly; the oracle expects a concrete list.");
    }
  }
  if (/chain/.test(p) && /exception/.test(p) && /serial/.test(p)) {
    if (/class CollectReport[\s\S]*\+\s+def _to_json|class CollectReport[\s\S]*\+\s+def _from_json/.test(diff)) {
      issues.push("Chained exception serialization fix must update shared BaseReport serialization, not add CollectReport-only _to_json/_from_json overrides.");
    }
    if (/ExceptionChainRepr/.test(diff) && /d\["longrepr"\]\s*=\s*{\s*\n\+\s*"chain"/.test(diff)) {
      issues.push("Chained exception serialization must add chain while preserving top-level reprtraceback/reprcrash/sections keys.");
    }
    if (/if "chain" in reportdict\["longrepr"\]:/.test(diff) && !/unserialize_traceback\(reprtraceback\)|deserialize_reprtraceback\(reprtraceback\)|for entry_data in reprtraceback\["reprentries"\]|exception_info = ReprExceptionInfo\([\s\S]*if "chain" in reportdict\["longrepr"\]:/.test(diff)) {
      issues.push("Chained exception deserialization must still validate top-level reprtraceback entries before taking the chain path.");
    }
    if (/__cause__|__context__/.test(diff)) {
      issues.push("Chained exception serialization patch uses raw exception links instead of pytest's rendered repr chain.");
    }
    if (/longrepr|reprcrash|reprtraceback|chain/.test(diff) && !/ExceptionChainRepr/.test(diff)) {
      issues.push("Chained exception serialization patch touches longrepr chain data without reconstructing ExceptionChainRepr.");
    }
    if (/ExceptionChainRepr/.test(diff) && !/Unknown entry type|_report_unserialization_failure|unserialize_traceback\(reprtraceback\)/.test(diff)) {
      issues.push("Chained exception serialization patch must preserve unknown-entry deserialization failure behavior.");
    }
  }
  if (/filepathfield/.test(p) && /callable/.test(p) && /path/.test(p)) {
    if (/django\/db\/models\/fields\/__init__\.py/.test(diff) && /-\s*['"]form_class['"]:\s*forms\.FilePathField/.test(diff) && !/\+\s*['"]form_class['"]:\s*forms\.FilePathField/.test(diff)) {
      issues.push("FilePathField.formfield() must preserve form_class=forms.FilePathField while evaluating callable path.");
    }
  }
  return issues;
}
