---
name: convex-two-transaction-limits
description: Convex aborts a transaction under TWO different budgets with two different error strings; a .collect() is 1 system op, not N. Get this right before sizing any chunk or page.
metadata:
  type: project
---

A Convex transaction can abort under **two separate budgets**, and they are not
the same thing. Sizing a chunk against the wrong one is off by ~100x.

| Budget | Error string | What counts | Ceiling |
|---|---|---|---|
| System operations | `Your request timed out performing too many system operations.` | One per **call**: each `db.get`, each index read (`.first()`/`.unique()`/`.collect()`/`.take()`/`.paginate()`), each `insert`/`patch`/`delete`, each `scheduler.runAfter` | ~900 comfortable, ~1,800 straining, ~4,000 failing (measured, `CARDS_PER_COMMIT_CHUNK` doc comment in `convex/selectorOptions.ts`) |
| Reads | `Too many reads in a single function execution` | One per **document** scanned | ~4,096 index ranges / 32k documents scanned / 16k written / 8MiB |

**A `.collect()` returning 754 rows is ONE system operation** (one index range),
and 754 document reads. It is a *reads* hazard, not a system-op hazard.

**Why: the repo says so, in three places.** `commitCardChecklist`'s action
doc comment enumerates the limits verbatim ("4096 index ranges read, 32k
documents scanned and 16k written, plus the system-operation time budget that
actually tripped"). `commitCardChecklistPrelude`'s cost note counts "one
`by_name_normalized_and_sport_id` lookup per distinct name … at 712 cards that
is ~1400 reads" — i.e. one lookup, one unit. And the `RESET_BATCH_SIZE` comment
records that a single-pass `.collect()` threw the *reads* error, not the
system-op one.

**How to apply:** when hunting the "too many system operations" defect
(NEO-296's class), the shape to grep for is a **loop doing per-row calls** —
especially a loop whose body calls a helper that itself does index reads, where
the cost is invisible at the call site. An unbounded `.collect()` on its own is
a different, much roomier problem. Count calls, not documents, and say which
budget a finding is against. Every subagent I have briefed on this has defaulted
to counting documents and inflated the pure-`.collect()` findings to the top of
the list; state the convention explicitly in the brief.

Related: [[convex-per-row-cost-hides-in-entity-helpers]].
