---
name: store-unlink-needs-nonempty-options
description: storeSelectorOptions runs the NEO-211 unlink pass only when `options` is non-empty, even with explicit returnedIds; a caller that filters every item pre-store silently skips unlinking
metadata:
  type: reference
---

`storeSelectorOptions`' unlink pass sits inside an `options.length > 0` guard
("an empty sync is not evidence of anything"), and `effectiveCoveredSides`
also drops a side whose `returnedIds` is empty. Explicit `returnedIds` do NOT
bypass the first guard.

So any pre-store filter in an aggregator (NEO-325 drops name twins before the
store) changes unlink behaviour at the edge: a fetch whose EVERY item is
filtered sends `options: []`, stores nothing and unlinks nothing, although the
marketplace answered and other rows' ids are genuinely gone. Safe direction
(links kept one sync longer), but a test that assumes "returnedIds present →
stale rows unlinked" will be wrong for that shape.

**How to apply:** when adding a pre-store filter, pin the all-filtered case
against what the store actually does; when a test needs to see values from a
convex-test run, `console.*` is mocked in most harnesses, so surface them with
a deliberately failing `expect(...).toEqual(null)` in a scratch file.
Related: [[store-loops-fall-through-to-insert]], [[sync-action-message-is-log-only]].
