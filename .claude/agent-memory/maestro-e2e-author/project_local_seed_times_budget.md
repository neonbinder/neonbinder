---
name: local-seed-times-budget
description: setup.yaml's drain loop `times: 250` is a ~10-minute WALL-CLOCK cap, not a row count — an idle (guard-false) iteration costs ~0.7s probe + 1s repeat delay in CI (measured, not the ~6.6s the flow comment claims), so a slow Wikidata lookup drain exhausts it with rows still undecided; seen locally (NEO-284) AND in CI (run 35484126549); also pass MAESTRO_FLOW_TIMEOUT_SEC=1500 locally or the 600s default kills the seed
metadata:
  type: project
---

**The signature.** `Assertion is false: ".*Confirm & Save.*" is visible` on
setup.yaml, with the failure screenshot showing the wizard on a `New Team:`
step, `Add as New Team` bright green, no `rowError`/`createBlocked` text, and
`N of M reviewed` where N = 300 bulk players + the loop's tap count. Every tap
decided a row; the loop simply ran out of `times`.

**Measured (CI run 35484126549, 2026-09-20).** 250 iterations = 80 taps +
170 SKIPPED. Idle iteration median 0.68s (max 6.57s) + ~1s repeat delay, so
the whole loop is capped at roughly 250 × (1.7–3.4s) ≈ 7–10 min regardless of
how many rows there are. Lookups took ~5 min to start landing (bulk taps began
4m40s after loop start) vs ~1m40s in the green NEO-287 seed (run 35307402573:
166 iterations = 116 taps + 50 idle). Fewer rows to answer (89 vs 116), still
red — the variable is lookup pace, which is external.

**Locally (NEO-284, 2026-09-16).** Same shape at "343 of 407 reviewed";
plus the 600s default `FLOW_TIMEOUT_SEC` kills the seed mid-drain — pass
`MAESTRO_FLOW_TIMEOUT_SEC=1500` (what `e2e.yml` gives the seed job).

**Why:** the flow comment sizes `times` as "must exceed the number of distinct
new teams" and says an idle iteration costs ~6.5s; both are wrong in CI today,
so the guard silently doubles as a lookup-drain timeout. **How to apply:** this
red is not the PR's change unless the diff touched the wizard, the lookup
queue or the flow. Diagnose by counting SKIPPED vs COMPLETED guard lines in
the loop and checking `N of M reviewed` arithmetic; a full rerun is the
correct immediate action. The durable fix is a flow change (propose, do not
slip into an unrelated PR): make the idle path WAIT for the next answerable
step (`extendedWaitUntil` on a `text:` regex matching either `Add as New
(Team|League)` or `Confirm & Save`) so an iteration is consumed per row, not
per poll — its timeout exceeds R5's 7s and needs Jason's sign-off at the site.
