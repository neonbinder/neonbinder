---
name: bsc-seller-sheet-reads-must-be-serial
description: BSC's seller sheet endpoint (seller/bulk-upload/results) breaks under concurrent reads for one seller; overlapping reads return two rows for one (card, condition) and the planner holds every card back
metadata:
  type: reference
---

Never read BuySportsCards' seller sheet (`POST seller/bulk-upload/results`) concurrently for one seller. NEO-415 tried four reads at once (one per modern condition) to cut drain time. BSC's answers then carried two rows with different product ids for one card in one condition. The planner (`planBscSheet`) blocked each such key as `duplicate_sheet_row`, so nothing listed and nothing came down. Serial reads never showed it.

The `seenProducts` dedupe in `listingDrain.ts` cannot hide this, because the twin rows have different productIds (BSC mints a fresh productId for a blank template row).

**Why:** a live listing/take-down spec failed on both CI projects right after the change. The drain logs showed the same call sequence as the serial run (4 reads, PUT, read-back), so only BSC's answers differed. The duplicates appear to persist: hours later a serial read still showed two listed rows (two productIds) for one card in one condition, so the account needs cleaning by hand before a spec on that set can pass.

**How to apply:** treat any proposal to parallelise BSC seller calls on one session as unsafe until shown otherwise against a real account. Speed up by reading fewer sheets, not by overlapping them. A unit test in `listingDrain.test.ts` pins `maxInFlight === 1`. Related: [[adapter-reauth-goes-through-refresh-site-token]].
