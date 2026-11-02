---
name: marketplace-listing-spec-shape
description: NEO-370 BSC listing spec shape - what "N listed" proves, leave-and-Back as the flush, cleanup on a second page, a stale-count-safe step order
metadata:
  type: pattern
---

A spec that proves box counts reach a marketplace (listing panel, "N listed on
<platform>.") has no BSC-side UI to read. The drain reads the seller sheet, PUTs,
and READS THE ROWS BACK; a mismatch becomes a "Can't list on ..." problem. So the
proof is the status line `^N listed on <platform>\.` plus `heldBack` toHaveCount(0).
`listed` counts card x condition rows, not copies.

Order the steps so each "N listed" is a DISTINCT count from the last (2 -> 1 -> 0):
a stale count then can never satisfy the next assertion, with no sleep needed.

The user's flush is leaving the checklist: click another Inventory tab, assert a
positive (the box spine count proves the writes landed), `page.goBack()`. The only
wait over 7 s is the live round trip, one named constant per the GUIDE exception.

Failure cleanup that must reach the remote system goes in `test.afterEach` on
`context.newPage()` (same signed-in context) so the failing page keeps its
screenshot; module-level `written` state says how far the run got; guard on
`testInfo.status !== testInfo.expectedStatus`. Do it through the product (quantity 0,
Resync, switch off), never by calling the marketplace.
