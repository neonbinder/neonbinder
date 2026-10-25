---
name: keep-counts-per-scope-not-global
description: A derived count an admin path can invalidate (e.g. "cards off set builds") belongs on the per-scope row (collectionBuildingSets.cards), not one global counter — a cleared scope recounts bounded, a cleared global count never recovers for a big owner
metadata:
  type: reference
---

When a collector-facing count can be knocked out by a catalog/admin write that
touches many owners (setShapeMove re-pointing copies between sets, a set
conversion moving building rows), store the count on the smallest row that
scopes it, not as one more field on the owner's Main tally.

NEO-359 "Everything else" = `tally.cards − Σ collectionBuildingSets.cards`.
- Copy writes bump the (owner, copy.setId) building row only when a WHOLE card
  is gained/lost (the tally's `cards` delta), so a second line never double-counts.
- Mark = bounded per-set count at insert; unmark = delete, nothing to adjust.
- Admin re-point / conversion just clears the touched rows (`forgetBuildingCards`);
  reads count an absent row by hand from `by_owner_set_variant` (bounded, shared
  budget), and the next write touching it recounts.
- A global counter would need a whole-collection recount after any invalidation,
  which can never finish for a dealer past the 5,000-line read: permanently inexact.

Testing quirk: `t.run` returns a handler's `undefined` as `null` — assert
`?? null` / `toBeNull()` for a cleared optional field.

Related: [[reference_convex_system_op_budget_and_bounded_walks]], [[reference_refuse_vs_truncate_a_bounded_read]].
