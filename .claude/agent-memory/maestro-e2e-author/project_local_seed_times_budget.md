---
name: local-seed-times-budget
description: setup.yaml's drain loop `times: 250` WAS a 7–10 minute WALL-CLOCK cap (idle iteration ≈ 0.7s probe + ~1s repeat pacing in CI, not the ~6.5s an older comment claimed); NEO-288 made the idle path wait on the next answerable step so an iteration is spent per row, not per poll; also pass MAESTRO_FLOW_TIMEOUT_SEC=1500 locally or the 600s default kills the seed
metadata:
  type: project
---

**The signature (pre-NEO-288 loop).** `Assertion is false: ".*Confirm & Save.*" is visible`
on setup.yaml, with the failure screenshot showing the wizard on a `New Team:` /
`New League:` step, the primary button bright green, no `rowError`/`createBlocked`
text, and `N of M reviewed` where N = bulk players + the loop's tap count. Every
tap decided a row; the loop simply ran out of `times`.

**Measured from `maestro.log` (RUNNING→SKIPPED spacing of the probe).** Idle
probe median 0.66–0.68s, iteration period ~1.7s (the repeat adds ~1s of pacing),
tap iteration ~2.2–2.3s. Two red loops spanned 424s (1 tap / 249 idle) and 592s
(80 taps / 170 idle). The 5-wide Wikidata lane drains a real Base set in 8–12
min, so a polling loop capped at 7–10 min was a coin flip on lookup pace, which
is external. A green loop the week before was 166 iterations = 116 taps + 50
idle, with lookups landing from ~1m40s instead of ~4m40s.

**How to measure it again.** Count `Run flow when id: … is visible` lines by
state (RUNNING / SKIPPED / COMPLETED) and diff consecutive timestamps; the
per-step `commands.json` durations do not show repeat pacing.

**The fix (NEO-288, Jason's sign-off 2026-09-20 at the site).** An
`extendedWaitUntil: visible: text: "Add as New (Team|League)|.*Confirm & Save.*"`
(240000, the setup track's live-Wikidata exception to R5) sits ahead of the
`runFlow when` probe inside the repeat. The web driver exposes the primary
button's label as both `text` and `resource-id`, so `text:` sees it; the tap
keeps `id:`. Verified with Maestro 2.8.0's own `YamlCommandReader` (drive it
from jshell/javac over `~/.maestro/lib/*` — there is no `--dry-run`) and with
`Matcher.matches()` that the alternation is a full match excluding `Add as New
Team anyway`, `Add as New Player` and `Add remaining players as new (N)`.

**Locally (NEO-284, 2026-09-16).** The 600s default `FLOW_TIMEOUT_SEC` kills
the seed mid-drain — pass `MAESTRO_FLOW_TIMEOUT_SEC=1500` (what `e2e.yml` gives
the seed job).

**How to apply:** a `Confirm & Save` red on the seed is now the wait failing by
name on a >240s gap between answerable steps, or `times` genuinely exceeded —
both are product/lookup findings, never a reason to raise a number. If the
loop comment's idle-cost figure and the log disagree again, fix the comment
(R10 hygiene) and re-derive the cap before touching the loop shape.
