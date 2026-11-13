---
name: filter-after-take-caps-read-rows
description: A capped read filtered afterwards caps READ rows, not SHOWN rows; index the filter field instead. Convex sorts undefined before numbers, so "unknown or > 0" is two index ranges.
metadata:
  type: feedback
---

A subscribed query that does `.take(CAP + 1)` and then drops rows in memory
(the catalog drill's `hiddenAsEmpty`) caps the rows it READ, so a parent with
more than CAP mostly-empty children can omit children that should be shown.
Synced set rows are mostly empty (a marketplace set list lands as rows long
before any checklist), so this bites brand columns before it bites anything
else. Found in NEO-527 review of `collectionCatalog.drill` / `withUnknownBrandSets`.

**Why:** the security/perf rule keeps subscribed reads near the cap, so the fix
cannot be "read more and filter"; it has to be an index whose range IS the
filter.

**How to apply:**
- Put the filter field last in a compound index after the equality prefix
  (`["level", "parentId", "subtreeCardCount"]`), and read the shown set as index
  ranges sharing one cap.
- Convex index order puts `undefined` (field absent) before every number, and
  `q.eq(field, undefined)` is legal. When absent means UNKNOWN-and-shown and
  0 means hidden, read `.gt(field, 0)` (desc, biggest first, so a truncation
  cuts the smallest) and then `.eq(field, undefined)` with what is left of the cap.
- Only do this where the index range matches the in-memory predicate exactly.
  `rowHasCards` has an "own `cardCount` > 0 wins over a drifted subtree count"
  guard on the card-bearing levels; an index on `subtreeCardCount` alone would
  miss that row there, so keep those levels on the plain read.
- An index on a ledger-maintained count adds index churn on every flush but no
  OCC conflict as long as only queries read it (see [[convex-occ-read-set-is-the-third-budget]]).
- No migration: an added index is built by the deploy; no field changes, so the
  preview schema rejects nothing.
