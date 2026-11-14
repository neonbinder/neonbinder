---
name: playermanagement-deeplink-test-flakes-under-load
description: Known full-suite-only unit flakes (PlayerManagement deep link, ScannerJoin focus-wait timer, bscSeller.telemetry clock digits) — rerun the one file alone before blaming your diff
metadata:
  type: reference
---

`components/admin/PlayerManagement.test.tsx` → "PlayerManagement — the ?player
deep link > writes the param for a player it has just created" asserted
`url()` was `''` instead of `'?player=p-trout'` during a full
`vitest run --project components` (67 files, high parallelism) on 2026-09-04,
then passed 55/55 when re-run alone seconds later, with no change to the file.

**Why it matters:** it looks like a real regression if your diff touched
anything selector- or routing-adjacent. It is not — the assertion reads
window history state that the harness has not flushed yet under load.

**How to apply:** if this one test fails in a full run and your diff does not
touch `components/admin/` or the search-param plumbing, re-run that single file
before investigating:
`npx vitest run --project components components/admin/PlayerManagement.test.tsx`.
If it passes alone, report it as a pre-existing flake rather than fixing your
own change. Do not fold a fix for it into an unrelated PR.

Two more seen on 2026-11-11 (NEO-464), each red in one full `npm run test:unit`
and green alone and in the next full run, in files the diff never touched:

- `app/collection/final/intake/ScannerJoin.test.tsx` → "the wait after the
  focus move > drops the timer when the panel goes away during the wait": a
  real-timer wait that loses the race under full-suite load.
- `convex/adapters/bscSeller.telemetry.test.ts` → "a 4xx naming an order, an
  address and a phone keeps only the code and status values": asserts the
  serialized session never contains the fixture phone's digits (`5309`), but
  the session JSON carries real `Date.now()` stamps, so it goes red whenever
  the wall clock's milliseconds happen to contain those four digits. Not a
  leak; the fixture should use digits a timestamp cannot hold, or a fake clock.

One more seen on 2026-11-12 (NEO-527): `app/dashboard/screen/panelLink.test.tsx`
→ "the ends of the batch: stepping ↓ stops at the last card …" hit vitest's
5000 ms default timeout (5147 ms) in one full `npm run test:unit`; the file is
~6 s for 20 tests alone, so that one test sits right at the ceiling. Green
alone and in the next full run. A red `test:unit` also makes
`verify-test-completeness` print "vitest reported success=false"; that is the
same red, not a dropped file.

Seen 2026-11-13 (NEO-536) with machine load average ~50-60 (parallel agents
plus a live Playwright run): every test that renders the whole
`DashboardScreen` (CrewDesk.test, DashboardScreen.test) took 3-9 s each and
hit vitest's 5 s timeout, and `app/dashboard/screen/panelLink.test.tsx` →
"a Fresh Pull: the click pushes…" failed `findByRole("dialog")` (1 s RTL
wait on the lazy card panel) even run alone — and equally on a detached HEAD
worktree, so not the diff. To tell load from logic, check `uptime` and rerun
the file with `--testTimeout=60000`; a scratch `git worktree add --detach`
at HEAD with `apps/web/node_modules` symlinked (copy `convex/_generated`)
proves a baseline red without touching the shared worktree.
