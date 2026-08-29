---
name: testing-set-builder-safely
description: How to explore Admin > Set Builder against the shared dev Convex deployment without writing large amounts of data
metadata:
  type: feedback
---

The Set Builder's "Fetch from Marketplaces" button is SAFE to click for read-only
exploration: it calls a Convex `action` (`fetchCardChecklist`) that only stages
a preview (`CardPairingModal` — Matched / BSC-only / SportLots-only buckets).
Nothing is written to `cardChecklist` until you click **Confirm**, which calls
the `commitCardChecklist` mutation. Clicking **Cancel** on the pairing modal
discards the preview ("Sync cancelled — no cards saved.") with zero DB writes.

**Why:** the shared dev deployment (`dev:focused-fox-53`, see `.env.local` ->
`CONVEX_DEPLOYMENT`) is used by other agents/tests too, and committing a full
checklist (e.g. 2021 Topps Heritage Base = 908 cards) pollutes it for everyone.

**How to apply:**
- To inspect real marketplace-derived data (card names, variation labels,
  matched/unmatched buckets) for a set: navigate Sport > Year > Manufacturer >
  Set > Variant Type in Admin > Set Builder, click the variant type, click
  "Fetch from Marketplaces", let it stream/finish, expand "Matched (N)" and
  the BSC-only/SportLots-only columns, then click **Cancel**. Never click
  **Confirm**.
- Selecting a "Base Set" mapping in the "Select Base Set" modal (attaching a
  SportLots set alongside an existing BSC one) is a small metadata write
  (which SL set id corresponds), not a checklist sync — fine to do to get
  richer preview data.
- To check whether a set already has committed checklist data (so you can
  view the real grouped/collapsed UI without fetching), query the dev
  deployment read-only: `npx convex data cardChecklist --limit 20000 --format
  jsonl` and `npx convex data selectorOptions --limit 20000 --format jsonl`,
  then join on `selectorOptionId` in a small Python script. `npx convex data`
  never writes.
- The Collection page (`/collection`) is a stub ("coming soon") — it does not
  show synced cards. The only place to see checklist data today is Admin >
  Set Builder.
