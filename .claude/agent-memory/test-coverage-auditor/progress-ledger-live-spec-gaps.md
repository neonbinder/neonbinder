---
name: progress-ledger-live-spec-gaps
description: Per-step progress ledger PRs: recurring gaps (lease guard on the progress write, call-order claims, rerun-dependent step lists, axe only on the finished state)
metadata:
  type: project
---

When a run records steps and a live spec waits per step:
- The internal progress-write mutation needs its own lease-guard test (lost lease writes nothing); a drain-level test does not prove it.
- A claim like "A before B" (price/quantity before publish) needs a test where one run has both, asserting call order; a single-step-per-run test does not.
- A spec asserting an exact step list (all condition sheets read) is only deterministic on a set's first run; reruns on a persisted set read fewer sheets. Assert what every run holds.
- Axe on the finished ledger leaves working / waiting / failed glyph states unchecked; ask for a component-level axe over all four states.
**How to apply:** check these four whenever a PR adds a progress ledger or step list.
