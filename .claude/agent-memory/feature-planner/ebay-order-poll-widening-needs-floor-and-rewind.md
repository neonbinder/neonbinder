---
name: ebay-order-poll-widening-needs-floor-and-rewind
description: Widening what the eBay order poll stores needs a creation-date floor (its read is "modified since") and a cursor rewind for orders already passed; eBay sandbox orders cannot be made on cue
metadata:
  type: project
---

The eBay sales poll reads Fulfillment orders MODIFIED since the cursor, not created since. While it kept only NB-SKU lines that was harmless; once it stores other lines (NEO-520, every eBay line), an order created before NB connected but shipped/refunded later would be imported. Any widening of what the poll stores needs an order-creation floor (the eBay listing state's creation), applied only to orders with no NB line.

Orders the poll already read and dropped are behind `orderCursorAt`. Picking them up needs a rewind; prefer a versioned cursor on the listing state (stamp the projection version on a complete read; a lower version rewinds to the state's start once) over a one-off armed function. Re-reads are safe because `recordOrderCore` never resets `applied`.

**Why:** NEO-520 planning (2026-11-12): two outside-tool eBay sales were dropped; Jason ruled "never import history from before NB".

**How to apply:** for any change to which eBay lines/orders are stored, plan the floor + rewind together and check the 10-page read limit (1,000 orders) against the rewind window. For E2E, eBay sandbox has no buyer NB can drive, so prove order handling with a testing seed that feeds a RAW Fulfillment order through `projectEbayOrder` and the poll's own record/apply steps (see [[external-lookup-determinism-for-e2e]]).
