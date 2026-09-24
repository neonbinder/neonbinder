---
name: reference-subtree-delete-intra-table-pointers
description: A paged leaf-first delete of a selector subtree still leaves pointers dangling between pages unless two intra-table dependents go in the same transaction as their target — selectorSyncStatus rows keyed on a PARENT name its children, and entityReviewQueue.source points at a sibling row in the batch
metadata:
  type: reference
---

Deleting a `selectorOptions` subtree "leaf first" (cards → keyed rows → node,
deepest node first) is not enough to keep every committed page free of
dangling ids. Two pointers run sideways or upward and are missed by that
ordering (both found by NEO-304's "assert zero dangling after EVERY partial
stop" test, at batchSize 1):

- **`selectorSyncStatus.unlinked[].id`** — a status row is keyed on
  `(childLevel, parentId)`, so the row describing an insert's parallel column
  is keyed on the INSERT and names the PARALLELS. Delete a parallel first and
  that notice dangles until the insert's turn. Fix: the mutation that deletes
  a node also deletes every status row keyed on that node's parent (≤7 reads).
- **`entityReviewQueue.source.playerRowId / teamRowId`** — a staged career
  team / league row points at another queue row in the same batch. A page
  boundary between them dangles the dependent. Fix: before deleting a queue
  row, read `by_source_player` / `by_source_team` and delete dependents first,
  in the same transaction (and budget ~3 ops per queue row).

Also: `cardChecklist.variationOfCardId` — delete a card's variation children
in the same transaction as the card (they are normally on the same row).

**How to apply:** any bulk or subtree delete here should be tested by looping
the entry point with the smallest page size and a zero time budget, and
running a full dangling-reference scan after EVERY call, not just at the end.
The end state alone hides these. For a schema-derived pin of "which tables
point at the rows I delete", strip comments from schema.ts first: a comment
reading `Re-add as v.id("selectorOptions")` on `userProfiles` matches a naive
grep.
