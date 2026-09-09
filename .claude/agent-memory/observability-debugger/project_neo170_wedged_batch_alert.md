---
name: neo170-wedged-batch-alert
description: PostHog placeholder_batch_wedged event + the alert to wire for stranded NEO-170 placeholder batches
metadata:
  type: project
---

NEO-170's placeholder pipeline has a **wedged-batch watchdog**
(`apps/web/convex/placeholderWatchdog.ts`, cron "heal wedged placeholder
batches" every 15 min) that detects and self-heals a batch whose progress
counter stranded — the safety net behind the f9eb1da per-job settle lock. Folded
into PR #180.

**Why:** a batch could hang forever at e.g. "5 of 6 images processed" when the
counter fell short of the true terminal image rows (workpool batching several
onCompletes into one transaction → lost read-modify-write increments), so
`processed+failed === totalImages` never became true and the hand-off to pairing
never fired. The watchdog's integrity check = count terminal (`done`+`failed`)
`placeholderImages` rows via the by-job index vs the job's
`processedImages+failedImages` counter; a mismatch is the fingerprint.

**Event to alert on:** PostHog `placeholder_batch_wedged` (dual-written as a
`console.warn` JSON line with `msg:"placeholder_batch_wedged"` so it survives an
unset POSTHOG_API_KEY). Key properties: `jobId`, `userId` (Clerk id only — no
PII, no objectPath), `mode`, `status`, `remediation`
(`recompute_completed` | `repaired_pairing` | `marked_wedged` |
`recompute_collecting`), `totalImages`, `storedProcessed/storedFailed`,
`trueDone/trueFailed/trueTerminal`, `nonTerminal`, `mismatchDelta`,
`countersDrifted`, `stuckEntryIndexes`, `staleMs`, `deployment`.

**How to apply — alert not yet wired in the PostHog UI (I left it to the user).**
When wiring it: alert on the COUNT of `placeholder_batch_wedged` per rolling
hour, filtered `deployment = "<prod deployment name>"` (prod — the same
environment-tag filter the NEO-43 credential alerts use, so per-PR preview / dev
noise never pages; one PostHog project serves all envs). Threshold >0/hour is
defensible for prod because the settle lock keeps the fast path whole, so any
occurrence is a real regression or a lost scheduled function. `remediation` says
whether it healed (recompute_completed/repaired_pairing) or gave up
(marked_wedged, → job `errorCode:"WEDGED"`); `jobId` points at the batch.

**Also new (NEO-170 correlation):** preprocess `adapter_sync_call` events now
carry optional `jobId` + `entryIndex` (from `callProcessEntry`/`callExtract`),
so a slow/failing `/process-entry` joins to the exact image — and to a batch
that later wedged. See [[convex-test-parallel-teardown-flake]] for the test
harness gotcha this work surfaced.
