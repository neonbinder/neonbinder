---
name: progress-ledger-error-finish-settles-working-failed
description: listingDrain ProgressLedger — an "error" finish settles the step still working as failed; a step that failed earlier needs ledger.fail(key), and later steps that finished need ledger.endWorking() before the error finish
metadata:
  type: reference
---

`finishVariant` settles the drainer's ledger with `settleSteps(steps, outcome.kind)`:
any step still `working` becomes `done` on an ok outcome and `failed` on an
error outcome; `waiting` steps are dropped.

So when a run ends in error because of an EARLIER step (eBay's photo upload
stopped, but items/offers/publish went on for the other cards):
- mark the earlier step with `ledger.fail("photos")` right where it failed
  (`start()` of the next step only ends `working` steps, so `failed` sticks);
- call `ledger.endWorking()` before the error `finish`, or the last step that
  actually completed (publish) reads `failed` too.

A test pinning the whole ledger (`stepsOf` → `["photos: failed", "items: done", …]`)
catches the second mistake; it is what caught it in NEO-415.

Related: [[action-impl-stub-ctx-for-write-failures]]
