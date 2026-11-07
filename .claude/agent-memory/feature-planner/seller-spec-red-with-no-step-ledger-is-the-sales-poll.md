---
name: seller-spec-red-with-no-step-ledger-is-the-sales-poll
description: A marketplace-seller spec red where Sync status shows "Synced, N listed" but no "Last sync steps …" list means the 15-minute sales poll drained the set before the spec's Sync press; the press's no-op run wiped the ledger. Pre-existing on main, fixed by NEO-433 (PR 425, stacked on NEO-432 PR 421). Not the PR under test unless it touches listingDrain/listingSales.
metadata:
  type: project
---

Triage rule for `inventory-ebay-sandbox-listing-*` / `inventory-bsc-listing-*`
reds at the "step … done" assert: look in the job's convex-logs for
`listingSales:pollAll` → `listingDrain:drainOwner` a few seconds BEFORE the
spec's `listingSync:syncVariant`. If so the poll listed the cards; the
press's run claimed the variant (`claimVariant` starts an empty ledger),
found nothing to send, wrote no steps, and the row shows counts with no
steps list. The spec cannot tell which run it is reading.

**Why:** seen 2026-11-05 on the NEO-424 PR (mobile pass; desktop passed
the same spec 20 min earlier), and the seller jobs were red on six other
PRs' runs that week. NEO-433's PR body names exactly this: "A press that
found nothing to send wiped the last run's steps and left an empty
record" and adds a "Compare with your boxes" step plus a run-following
helper in the specs.

**How to apply:** a PR whose diff has no listing/eBay/sales files is not
the cause; say so with the log evidence and recommend a full rerun (never
`--failed`), and merging main once PR 421 → 425 land. Delete this memory
once NEO-433 is on main.
