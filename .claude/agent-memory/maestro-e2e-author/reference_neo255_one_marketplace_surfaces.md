---
name: neo255-one-marketplace-surfaces
description: NEO-255 — what a ONE-marketplace checklist sync puts on screen instead of the Match Cards dialog, and the lint that trips on merely naming that dialog
metadata:
  type: reference
---

When exactly ONE marketplace is **attached** to a row, `handleSync` never enters
the review phase, so `CardPairingModal` never mounts. Attachment is
`attachedSidesOf(chain)` (`convex/marketplaceResolvability.ts`): BSC iff any
`BSC_SOURCE_FACETS` filter is populated (the setName row's id counts), SportLots
iff a row at `setName | variantType | insert | parallel` carries an SL id. The
sport/year rows' SL ids are irrelevant — so **any real BSC set whose Base has
never been mapped on SportLots is a one-sided fixture.**

Surfaces to key on (verified in the NEO-255 branch, `CardChecklist.tsx`):

| what | selector |
|---|---|
| inline progress, structural anchor | `id: "Cancel checklist fetch"` — worded so no `id:` regex confuses it with `Cancel card matching` / `Cancel entity review`; renders only while the solo fetch is in flight |
| inline progress, sentence | `Fetching from <BSC\|SportLots>… <ready> of <total> cards ready.` — the `n of n` half exists only between batch publish and enrichment catch-up, so its window can be short on a small set |
| the result, and the FETCH COUNT | `Kept all <n> cards from <marketplace>. Nothing to match, no other marketplace attached.` — appears only once the action RESOLVED, so it is the solo path's equivalent of waiting on `^Confirm$` |
| stream never arrived | `The fetched cards did not arrive — nothing was saved. Run the sync again.` (30s cap; commits nothing) |
| wizard | opens as normal, but **no "Back to matching"** — `onBack` is gated on `streamedPairing`, which is null when the review phase was never entered |
| the kept card's badge | `BSC only` (token `unmatched-sl`) / `SL only` (token `unmatched-bsc`) — the mapping in `CardChecklistItem.badgeLabel` reads inverted at a glance |

**`scripts/maestro-pairing-sync.test.mjs` trips on the LITERAL string
"Match Cards" appearing anywhere in a flow file** — including inside an
`assertNotVisible` that proves the dialog is absent. It then demands a
`text: "^Confirm$"` wait the flow has no button for. The sanctioned escape is
the documented marker, which must carry a reason:

```
# maestro-lint: streaming-ok — <why this flow wants the streaming state>
```

Run it (and its siblings) with **vitest**, not `node --test`:
`npx vitest run scripts/maestro-flow-names.test.mjs scripts/maestro-pairing-sync.test.mjs`.

A one-sided flow cannot be validated against shared dev: without the server's
new `attachedSides` field the client reads `serverSides.length` off `undefined`
and throws. See [[never-push-a-branch-convex-to-shared-dev]] and
[[local-validation-needs-a-pr-preview]]. Fixture rules:
[[all-brands-is-where-the-one-sided-sets-live]].

## Measured on PR #242's preview, 2026-09-07

The inline progress line is **too short-lived to assert**: on a 25-card BSC-only
set the whole `Fetching from BSC… <n> of <m> cards ready.` sentence is up ~1.3s
and the `<n> of <m>` half ~0.25s (32 cards: ~3.0s / ~0.75s), and the numerator
never leaves 0. maestro-web spends ~2s per step in `hierarchyBasedTap`, so the
window is gone before the next command reads the screen. Do not assert it and do
not inflate the fixture to make it assertable — leave it to the unit tests. The
same applies to `id: "Cancel checklist fetch"`, which lives in the same window.

`Kept all N cards from <marketplace>. Nothing to match, no other marketplace
attached.` IS assertable and is the R2 gate: it is produced on ONE branch
(`expectSolo && agreed && serverSides.length === 1`, after the streamed batch
arrived in full), while the pre-existing `candidateCount === 0` fall-through
prints nothing at all.

A flow on this path still cannot go green: see
[[maestro-web-cannot-scroll-after-base-picker]].
