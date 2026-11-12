---
name: version-stamp-rewind-pattern
description: Review checklist for a per-row "read version" field that triggers a one-time cursor rewind (absent = old version) on a polled state table
metadata:
  type: feedback
---

When a state row gets an optional `xReadVersion` (absent = 1) whose bump makes
the poll re-read from an earlier floor, check three things every time:

1. **New rows are born at the current version.** If the insert sites do not
   stamp it, every row created after the deploy reads as "old" and takes the
   rewind on its first poll. Test helpers that seed the field to the current
   value by default hide this: ask for one test through the real insert path.
2. **A page-capped read needs a give-up path.** If "stamp only on a complete
   read" meets a fixed read budget (N pages) and a fixed floor, a window larger
   than the budget never completes: the rewind repeats every tick, the stored
   cursor never advances, and an upsert-per-order recorder rewrites every row
   each time. Stamp on budget exhaustion (not on transport errors) when the
   catch-up is display-only.
3. **The stored cursor is never moved back.** The rewind should live only in
   the poll's input; docs that say "rewinds the cursor" mislead.

**Why:** found reviewing NEO-520 (eBay order catch-up), 2026-11-12; all three
were live in the diff or its docs.
**How to apply:** any review of a versioned re-read, backfill-by-cursor, or
"absent means old" optional field on a polled table.
