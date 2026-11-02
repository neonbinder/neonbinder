---
name: patterns-neo370-listing-gate-doors
description: Write-time readiness gate ("copies into a listed box need price + condition") — enumerate every door that puts a copy into a home, not just the add mutations; the forHome owner-scoped read shape that held
metadata:
  type: project
---

NEO-370 added a gate refusing adds into a listing home unless the copy has
a price and a condition. It is a product-integrity rule (the drain holds an
unready copy back as noPrice/noCondition anyway), not an authz boundary, so
a bypass is should-fix, not blocker. The gate was wired into the forward add
doors only. Doors to enumerate on any "before X goes in, require Y" gate:

- the add mutations (addOne and its callers), quick-count raise;
- **undo/restore doors**: `restoreCopy` takes a full client-supplied details
  object (a raw add API), and `undoBoxQuantity` "restore"/raising "set" steps
  from a forgeable inverse;
- **move doors**: `moveCopy`/`moveCopyCore` binder -> listed box (Sell);
- **relocation side-effects**: `collectionContainers.empty` dumps a box into
  Unsorted, which is a box that lists by default;
- **state flips after the fact**: a box's listed flag off -> on, clearing a
  copy's own price via `updateCopy`, removing a common price, starting sync.
  These are accepted only if the drain backstop is named as the guarantee.

grep: `insert("collectionCopies"`, `patch(... homeId`, every caller of the
shared put/move helpers.

What held for the read (`listingGate.forHome`): owner from identity, ids as
`v.string()` + `normalizeId`, foreign/junk/absent home all return the same
literal "none" object, price read only from the caller's own row; bounded
(state rows take(8) + one get + one unique). A client-imported readiness lib
must stay pure (no `process.env`; the pause read lives in listingOutbox,
which components never import). Related: [[patterns-neo364-client-carried-undo]],
[[patterns-neo370-scheduled-marketplace-poll]].
