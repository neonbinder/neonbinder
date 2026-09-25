---
name: sets-sync-is-year-wide-and-populated-gated
description: A brand's Sets column auto-sync files BSC's WHOLE year but asks SportLots for that brand only, and any column that already has a row never auto-syncs — so a second brand of the same year never gets its SportLots phase unless Sync Sets is pressed; design fixtures around it
metadata:
  type: reference
---

Read out of `ensureSelectorOptions` / `syncSetsAcrossManufacturers` (NEO-237,
NEO-305 era). Three facts that decide whether a fixture flow gets SportLots-
derived sets at all:

1. **The auto-sync fires only on an EMPTY column** (`already_populated` skip,
   no `force`). Pressing the idle `Sync Sets` button is the forced path.
2. **A brand column's Sets sync is year-wide on the BSC side** (BSC has no
   manufacturer facet; the whole year list is filed under every brand by
   prefix, rest under `Unknown`) **but brand-scoped on the SportLots side**
   (`manufacturerId` = the brand whose column fired it).
3. **No "already syncing" guard.** Two clients opening the same cold column
   together can both run the sync. Writes are id-keyed and set clashes are
   refused in-mutation, so expect a doubled round-trip, not a doubled row —
   but it is a reason to keep one cold driller per brand-year.

**Consequence:** once brand A's column has synced a year, brand B of that
year is already populated by BSC's filing, so opening B runs NO SportLots
phase — a flow expecting B's SportLots-only sets is order-dependent unless
it presses `Sync Sets`. Pick one brand-year per flow, or force the sync.

**NEO-305 corollary:** where BSC answered and the brand has a flagship (a set
named exactly the brand prefix), EVERY SportLots-only name in that brand is
absorbed (`flagshipAbsorbs`), not only colours. SportLots-derived sets still
appear under `Unknown` (never absorbs), under brands with no flagship set,
and when the BSC phase did not file. The dependable live source of a
SportLots-derived set on a flagship brand is `Promote to set` on a parallel
that the Parallels reconcile paired with SportLots.

Related: [[all-brands-view-lists-every-set]] is marketplace-free;
[[probe-a-fixture-without-draining-it]] for measuring a candidate year.
