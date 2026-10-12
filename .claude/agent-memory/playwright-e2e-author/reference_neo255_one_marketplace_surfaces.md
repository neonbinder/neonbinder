---
name: neo255-one-marketplace-surfaces
description: NEO-255 — what a ONE-marketplace checklist sync puts on screen instead of the Match Cards dialog, and which of those surfaces are assertable
metadata:
  type: reference
---

When exactly ONE marketplace is **attached** to a row, `handleSync` never enters the
review phase, so `CardPairingModal` never mounts. Attachment is
`attachedSidesOf(chain)` (`convex/marketplaceResolvability.ts`): BSC iff any
`BSC_SOURCE_FACETS` filter is populated (the setName row's id counts), SportLots iff a
row at `setName | variantType | insert | parallel` carries an SL id. The sport/year
rows' SL ids are irrelevant, so **any real BSC set whose Base has never been mapped on
SportLots is a one-sided fixture.**

Surfaces to key on (`CardChecklist.tsx`):

| what | handle |
|---|---|
| inline progress, structural anchor | the `Cancel checklist fetch` button (renders only while the solo fetch is in flight) |
| inline progress, sentence | `Fetching from <BSC\|SportLots>... <ready> of <total> cards ready.` |
| the result, and the FETCH COUNT | `Kept all <n> cards from <marketplace>. Nothing to match, no other marketplace attached.` (appears only once the action RESOLVED, so it is the solo path's equivalent of waiting on the Confirm button) |
| stream never arrived | `The fetched cards did not arrive — nothing was saved. Run the sync again.` (30 s cap; commits nothing) |
| wizard | opens as normal, but **no "Back to matching"** (`onBack` is gated on `streamedPairing`) |
| the kept card's badge | `BSC only` (token `unmatched-sl`) / `SL only` (token `unmatched-bsc`): the mapping in `CardChecklistItem.badgeLabel` reads inverted at a glance |

**The inline progress line is too short-lived to assert** (measured on PR #242's
preview, 2026-09-07): on a 25-card BSC-only set the whole `Fetching from BSC...`
sentence is up ~1.3 s and the `<n> of <m>` half ~0.25 s, and the numerator never
leaves 0. Do not assert it and do not inflate the fixture to make it assertable;
leave it to the unit tests. The same applies to the `Cancel checklist fetch` button.
`Kept all N cards from <marketplace>...` IS assertable and is the R2 gate: it is
produced on ONE branch (`expectSolo && agreed && serverSides.length === 1`, after the
streamed batch arrived in full), while the pre-existing `candidateCount === 0`
fall-through prints nothing at all.

Asserting that the Match Cards dialog is ABSENT is a negative: pair it with the
positive `Kept all N cards` assertion ([[negative-asserts-pass-on-a-dead-page]]).

A one-sided spec cannot be validated against shared dev: without the server's new
`attachedSides` field the client reads `serverSides.length` off `undefined` and
throws. See [[feedback_never_push_a_branch_convex_to_shared_dev]] and
[[project_local_validation_needs_a_pr_preview]]. Fixture rules:
[[all-brands-is-where-the-one-sided-sets-live]].
