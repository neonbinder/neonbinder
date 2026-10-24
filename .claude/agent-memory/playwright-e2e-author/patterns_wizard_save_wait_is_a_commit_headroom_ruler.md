---
name: wizard-save-wait-is-a-commit-headroom-ruler
description: A red "Saved N cards" after Confirm & Save of a ~300-card wizard commit is a thin-headroom signature, not a thrown commit; how to read the two failure artifacts and what a healthy commit measures
metadata:
  type: reference
---

`Confirm & Save` -> `Saved N cards` on a ~300-card set (the one-marketplace wizard
specs) is a 4-phase client-driven commit: prelude, 150-card chunks, finalize pages
(rows walk, then the review-row drain), then `discardCandidates`, and only then
the banner. Healthy it is about 3.5 s end to end from a laptop (server mutation
time under 3 s), so the 7 s budget leaves only ~2x headroom: any load window that
slows heavy writes 1.5-2x on a shared preview trips it on one shard while the
other project's pass is green.

Reading the failure artifacts of such a red:
- `error-context.md` shows the dialog still `Saving...` on the "Save N cards?"
  step with `Decided (N)` present and the banner still "Kept all N cards..."; no
  `Commit failed:` text means the commit had not thrown.
- The failure PNG can be taken a moment LATER and show the wizard at "Step 1 of N,
  Looking up 0 more names": that is not a reset. The finalize review-phase page has
  drained the batch's review rows under the still-open wizard, so it re-derives
  from nothing. It proves the commit was alive in its last phase.
- Cards already listed behind the dialog ("Cards (300)") mean the chunks landed.

Proof order: the other project's pass of the same spec (green, same shard cost),
the median ratio of all spec durations vs a prior green run (about 1.0 means not
a global slowdown; a few 1.5-2x outliers is the saturation shape, see
[[heavy-write-saturation-vs-blanket-stall]]), and a local run against the PR's
preview with `convex logs --success --jsonl` (Completion records carry
`executionTime` per mutation). `convex logs` history on a preview only reaches back
about 5 minutes, so the CI window itself is gone by the time you look: ask for the
capture to include the failing shard's whole window.
