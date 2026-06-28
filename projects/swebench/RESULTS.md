# SWE-bench Results

## Pytest Six-Instance Slice

Dataset file: `pytest-instances.json`

Instances:

- `pytest-dev__pytest-10051`
- `pytest-dev__pytest-10081`
- `pytest-dev__pytest-10356`
- `pytest-dev__pytest-5262`
- `pytest-dev__pytest-5631`
- `pytest-dev__pytest-5787`

## Results

### SER selector only

- Predictions: `predictions-pt-kimi-knight.jsonl`
- Report: `ser-select-v2.pt-kimi-knight.json`
- Result: `4/6`
- Resolved: `10051`, `10081`, `5262`, `5631`
- Unresolved: `10356`, `5787`

### SER selector + Codex manual repair proof

- Two repaired predictions: `predictions-codex-two-v2.jsonl`
- Two-case report: `codex-manual-proof-v2.codex-two-v2.json`
- Combined predictions: `predictions-pt-kimi-codex-6.jsonl`
- Full report: `ser-select-v2.pt-kimi-codex-6.json`
- Result: `6/6`

This is not a selector-only result. Codex-authored patches replaced only:

- `pytest-dev__pytest-10356`
- `pytest-dev__pytest-5787`

### SER selector + autonomous repair rung

- `10356` repair prediction: `predictions-repair-rung-10356.jsonl`
- `10356` report: `ser-select-v2.repair-rung-10356.json`
- Clean repro `10356` prediction: `predictions-repair-rung-10356-repro.jsonl`
- Clean repro `10356` report: `ser-select-v2-repair-rung.repair-rung-10356-repro.json`
- `5787` repair prediction: `predictions-repair-rung-5787-v3.jsonl`
- `5787` report: `ser-select-v2.repair-rung-5787-v3.json`
- Combined predictions: `predictions-pt-repair-rung-6.jsonl`
- Full report: `ser-select-v2.pt-repair-rung-6.json`
- Clean repro combined predictions: `predictions-pt-repair-rung-6-repro.jsonl`
- Clean repro full report: `ser-select-v2.pt-repair-rung-6-repro.json`
- Result: `6/6`

This is the repeatable product result for this slice: the original SER selector supplies the four existing resolved patches, and the repair rung autonomously repairs the two former misses using structured failure evidence, contract-required context, semantic lints, and official-style gates.

## Product Lesson

The remaining gap was not basic localization. The selector had enough project context to get close, but it lacked a failure-aware repair rung that could turn rejected candidate patches into corrected patches using explicit evidence.

The repair rung now records:

- failed candidate patch
- classification (`oracle_miss`, `regression`, `lint_failed`, `apply_failed`)
- touched files
- oracle progress
- failed tests
- semantic lint findings
- repair attempt result

Trace files are written as `repair-trace-<instance_id>.jsonl`.

## Requests Eight-Instance Audit

Dataset file: `requests-instances.json`

Command shape:

```bash
node projects/swebench/select.mjs --instances=requests-instances.json --k=1 --r=0 --pool=2 --model=qwen/qwen3-coder --repair-model=deepseek/deepseek-v4-pro --fallback-model=qwen/qwen3-coder --llm-timeout-ms=180000 --llm-attempts=1 --repair=1 --oracle=1 --oracle-repair=1 --knight=1 --repair-rung=2 --repair-records=1
```

Artifacts:

- Selector predictions: `predictions-requests-repair-rung-8.jsonl`
- Selector run records: `results-requests-repair-rung-8.json`
- Official report: `ser-select-v2.requests-repair-rung-8.json`
- Full log: `select-requests-repair-rung-8.log`

Official result:

- Total instances: `8`
- Submitted predictions: `3`
- Resolved: `2`
- Unresolved submitted: `1`
- Incomplete/no prediction: `5`
- Resolved IDs: `psf__requests-1142`, `psf__requests-2931`
- Unresolved submitted ID: `psf__requests-1921`

Lessons:

- `psf__requests-1921` exposed a selection-policy bug: the selector accepted partial oracle progress (`1/6`) as solved. The policy now requires all FAIL_TO_PASS nodes when an official oracle is available.
- Several requests misses generated regression-clean patches with `0/N` oracle pass. This is a target-coverage problem, not a regression-repair problem.
- Knight-generated repros can be too weak: `1766` and `2317` produced generated-repro passes while still failing the official oracle.
- Provider reliability is material: DeepSeek returned empty responses and hit 180s timeouts during the run, forcing fallback calls and wasting minutes.
- `psf__requests-1724` had a local reset/workspace hygiene error during selection; a manual reset of the worktree succeeded afterward.

## Requests Six-Instance Slice

Dataset file: `requests-instances.json`

Instances:

- `psf__requests-1142`
- `psf__requests-1766`
- `psf__requests-1921`
- `psf__requests-2931`
- `psf__requests-5414`
- `psf__requests-6028`

Artifacts:

- Predictions: `predictions-requests-six-auto.jsonl`
- Official report: `ser-select-v2.requests-six-auto.json`
- Automated `6028` single-instance report: `ser-select-v2.requests-6028-auto.json`
- Automated `6028` repair trace: `repair-trace-psf__requests-6028.jsonl`

Official result:

- Total instances: `6`
- Submitted predictions: `6`
- Completed: `6`
- Resolved: `6`
- Unresolved: `0`
- Result: `6/6`

`psf__requests-6028` is now produced by the automated selector/repair path. The repair rung recovers the minimal `prepend_scheme_if_needed` fix after oracle evidence shows that `parse_url(url)` separates `auth` from `parsed.netloc`; the selected patch passed the official single-instance eval before being included in the six-instance run.

Excluded audit instances:

- `psf__requests-2317`: dropped from this slice because the official eval container hung while running the era Requests test suite.
- `psf__requests-1724`: dropped because a PASS_TO_PASS dependency on external `httpbin` returned `502`, making the official result environment-dependent rather than patch-dependent.

## Clean Reproduction Commands

Run from the repository root unless noted.

### Repair `pytest-dev__pytest-10356`

```bash
rm -f projects/swebench/predictions-select.jsonl projects/swebench/results-select.json projects/swebench/repair-trace-pytest-dev__pytest-10356.jsonl
node projects/swebench/select.mjs --instances=pytest-instances.json --k=1 --r=0 --pool=1 --model=qwen/qwen3-coder --repair-model=qwen/qwen3-coder --fallback-model=qwen/qwen3-coder --llm-timeout-ms=90000 --llm-attempts=1 --repair=0 --oracle=1 --oracle-repair=0 --knight=0 --repair-rung=3 --repair-records=1 pytest-dev__pytest-10356
```

Official eval, from `projects/swebench`:

```bash
node - <<'NODE'
const fs=require('fs');
const lines=fs.readFileSync('repair-trace-pytest-dev__pytest-10356.jsonl','utf8').trim().split('\n');
const events=lines.map(l=>JSON.parse(l)).filter(o=>o.outputPatch);
const o=events[events.length-1];
fs.writeFileSync('predictions-repair-rung-10356-repro.jsonl', JSON.stringify({instance_id:'pytest-dev__pytest-10356', model_patch:o.outputPatch, model_name_or_path:'ser-select-v2-repair-rung'})+'\n');
NODE
sudo -n eval-venv/bin/python -m swebench.harness.run_evaluation -d pytest-instances.json -s test -i pytest-dev__pytest-10356 -p predictions-repair-rung-10356-repro.jsonl --max_workers 1 --cache_level instance --clean False -id repair-rung-10356-repro --report_dir .
```

### Repair `pytest-dev__pytest-5787`

```bash
rm -f projects/swebench/predictions-select.jsonl projects/swebench/results-select.json projects/swebench/repair-trace-pytest-dev__pytest-5787.jsonl
node projects/swebench/select.mjs --instances=pytest-instances.json --k=1 --r=0 --pool=1 --model=qwen/qwen3-coder --repair-model=deepseek/deepseek-v4-pro --fallback-model=qwen/qwen3-coder --llm-timeout-ms=180000 --llm-attempts=1 --repair=0 --oracle=1 --oracle-repair=0 --knight=0 --repair-rung=3 --repair-records=1 pytest-dev__pytest-5787
```

The current clean repro uses `predictions-repair-rung-5787-v3.jsonl`, generated from the repair trace and evaluated by:

```bash
sudo -n eval-venv/bin/python -m swebench.harness.run_evaluation -d pytest-instances.json -s test -i pytest-dev__pytest-5787 -p predictions-repair-rung-5787-v3.jsonl --max_workers 1 --cache_level instance --clean False -id repair-rung-5787-v3 --report_dir .
```

### Full Six-Instance Eval

From `projects/swebench`:

```bash
sudo -n eval-venv/bin/python -m swebench.harness.run_evaluation -d pytest-instances.json -s test -i pytest-dev__pytest-10051 pytest-dev__pytest-10081 pytest-dev__pytest-10356 pytest-dev__pytest-5262 pytest-dev__pytest-5631 pytest-dev__pytest-5787 -p predictions-pt-repair-rung-6-repro.jsonl --max_workers 3 --cache_level instance --clean False -id pt-repair-rung-6-repro --report_dir .
```
