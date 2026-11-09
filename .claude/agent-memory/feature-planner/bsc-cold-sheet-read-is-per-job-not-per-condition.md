---
name: bsc-cold-sheet-read-is-per-job-not-per-condition
description: BSC seller sheet reads 503 at the 30 s gateway on the first read of a cold session, whatever the condition; reading fewer conditions does not stop it, and a warm-up outside the seller queue overlaps reads
metadata:
  type: project
---

BSC's `seller/bulk-upload/results` 503s (`{"message":"Service Unavailable"}`, 33 bytes, at exactly ~30 s) on the
FIRST sheet read of a cold job, whichever condition is asked first; later conditions of the same set answer in
~4-5 s. A retry 10 s after the 503 succeeded about half the time (answer took 5-30 s, so BSC is still warming); a
later attempt minutes on answers in ~1 s. Warmth from the CI cleanup does not reliably carry to the spec's own
first drain read minutes later. (NEO-475 survey, 40 seller jobs, 2026-11-09.)

**Why:** a plan that cuts the number of condition sheets read (Jason's NEO-475 decision) is right on cost but does
not by itself remove the cold 503; it needs a bounded 503-only retry beside it.

**How to apply:** pair any "read fewer sheets" plan with a serial, 503-only, same-condition retry inside
`listingDrain.readSheets`. Never plan a warm-up read outside the CI seller queue or concurrent with another read:
overlapping reads for one seller are what minted twin rows (NEO-415). Related: [[seller-specs-race-background-drains]].
