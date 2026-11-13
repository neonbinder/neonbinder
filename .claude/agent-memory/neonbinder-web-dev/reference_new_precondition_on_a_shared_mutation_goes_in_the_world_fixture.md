---
name: reference-new-precondition-on-a-shared-mutation-goes-in-the-world-fixture
description: Adding a refusal to a mutation many convex-tests call (e.g. a price rule on intakeRuns.saveIntakeMatch) — satisfy it in the file's world() fixture and give the rule's own tests an opt-out helper; priceEveryVariant is idempotent, so a later call at another price is a silent no-op
metadata:
  type: reference
---

A new precondition on a mutation that dozens of tests call for other reasons
(NEO-481's "a box card saves with a price" broke 41 intake tests at once) is
cheapest to absorb in the test file's shared `world()` fixture, not test by
test: satisfy the rule there (`priceEveryVariant(t, ME.subject)`), and give the
rule's own tests an opt-out helper (`unpriced(w)` deleting the rows) plus a
`bare()` builder for the refusal cases.

Gotcha: `lib/testing/common-prices.ts`'s `priceEveryVariant` skips a variant
that already has a row. Once `world()` prices at the default, a test that
later calls it at another price (75) keeps the old one with no error; clear
first (`unpriced`), then re-price.

Sibling files with their own `world()` (e.g. `intakePhotoAside.test.ts`) need
the same treatment; a run's own default (`defaults: { minPriceCents }`) is the
lighter fix when the subject isn't prices.

Related: [[reference-convex-typecheck-excludes-test-files]] (the gate won't
tell you which test call sites a server change breaks; run them).
