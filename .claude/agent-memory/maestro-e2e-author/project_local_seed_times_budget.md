---
name: local-seed-times-budget
description: Seeding a PR preview from the Mac can fail in ways CI never shows — the 600s default per-flow timeout kills setup.yaml mid-drain (CI passes MAESTRO_FLOW_TIMEOUT_SEC=1500), and the drain loop's `times: 250` runaway guard burns ~3x faster locally because a false `runFlow when` guard costs ~2s here vs ~6.6s on Linux CI
metadata:
  type: project
---

Observed 2026-09-16 (NEO-284), two consecutive `npm run test:e2e -- setup`
runs against a PR preview:

1. **Killed at 600s.** `run-e2e-smoke.sh` defaults `FLOW_TIMEOUT_SEC` to 600
   and the seed runs ~14 min in CI; `e2e.yml` sets
   `MAESTRO_FLOW_TIMEOUT_SEC: "1500"` for the seed job. Pass the same locally.
2. **`times: 250` exhausted at "343 of 407 reviewed"** with 64 team rows still
   undecided and `Add as New Team` on screen. The loop had logged 413
   iterations, 278 of them SKIPPED (guard false, ~34/min), versus 132/9 in the
   same day's green CI seed. A false `runFlow when` poll costs ~2s on the Mac
   driver and ~6.6s on CI's, so a lookup stall of a few minutes (the staged
   career-team Wikidata round) eats the runaway budget locally and barely
   dents it in CI.

**Why:** the budget was sized from CI's poll cost; it is not a product
signal. **How to apply:** for local validation prefer flows that do not need
the Chrome commit (Ohtani link targets), and say in the report which flows
were covered by CI instead; do not edit `setup.yaml` to appease the Mac. A
third local attempt is churn unless something changed.
