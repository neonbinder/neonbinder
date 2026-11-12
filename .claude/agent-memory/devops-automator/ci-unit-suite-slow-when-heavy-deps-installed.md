---
name: ci-unit-suite-slow-when-heavy-deps-installed
description: Unit suite fast locally but ~6x slower in CI because CI has torch installed and an unguarded real-model load runs; diagnose via per-test log timestamps
metadata:
  type: feedback
---

A test suite that is fast on a dev machine without the heavy ML deps can be
~6x slower in CI, where requirements install torch/transformers: any fallback
stage that does `import torch` inside a try/except silently succeeds in CI and
really loads and runs the model per test. Fix is an autouse conftest guard on
the loader (the house pattern already used for BiRefNet), not xdist.

**Why:** preprocess unit tests took ~15 min in CI vs ~2.5 min locally; pip was
under a minute, pytest was 14 min; ~10 s gaps between PASSED lines in the
`-v` log named the tests.

**How to apply:** when a CI job is "much slower than local", compute per-test
gaps from `gh run view --log` timestamps before theorising about runners,
caches or parallelism. Also: coverage's default tracer costs ~2.4x on
numpy/Pillow-heavy tests; `COVERAGE_CORE=sysmon` with `branch=false` is ~1.0x
on Python 3.12. Do not trust an xdist timing on a loaded dev box.
