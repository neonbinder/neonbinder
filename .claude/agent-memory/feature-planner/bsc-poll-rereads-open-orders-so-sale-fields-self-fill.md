---
name: bsc-poll-rereads-open-orders-so-sale-fields-self-fill
description: The BSC sales poll re-reads up to MAX_OPEN_ORDER_REFRESH non-final stored orders every run, so a new field recordOrderCore writes fills open orders with no backfill; BSC order items carry a sportId that maps to sport rows' platformData.bsc slot
metadata:
  type: project
---

`listingSales.pollOwnerSteps` re-reads (GET seller/order/{id}) up to
`MAX_OPEN_ORDER_REFRESH` stored, non-final BSC orders on every poll, newest
first, even when their status has not changed, and each read goes through
`recordOrderCore`. So a new per-line field that the parser and
`recordOrderCore` write ("fresh read wins, keep old when absent") reaches every
recent open order within one poll after deploy. Only open orders older than
that window need a backfill.

**Why:** NEO-509 asked for a backfill to fill one open 80-line order. The
regular poll would have filled it anyway. Say so in the plan before anyone
builds a one-shot script ([[prod-data-scripts]] in coordinator memory: one-shot
scripts are deleted once they have run).

**How to apply:** For any "store more of the marketplace order" change, check
the refresh window before planning a backfill. If a field must map to an NB
row, use the order item's id (BSC `orderItems[].sportId`, e.g. "football",
the same wire value as the sport row's `platformData.bsc` slot). Resolve it in
`recordOrderCore`, which is the sync boundary, with an exactly-one guard, and
store the NB id. Never match on the display string.
