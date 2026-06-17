# halt-fixture

Empty workdir for `examples/halt-demo/halt-demo.yaml`. The mock build writes the
wrong content here so the gate `grep -q OK src/report.txt` fails every rung and the
mission halts honestly — used to exercise the TUI's diagnosis path.
