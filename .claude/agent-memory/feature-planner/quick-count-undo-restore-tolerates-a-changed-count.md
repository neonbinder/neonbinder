---
name: quick-count-undo-restore-tolerates-a-changed-count
description: collectionInventory undoBoxQuantity restore steps deliberately fold into a plain line that appeared since; never add an expected-count guard to the inverse. Replay/forgery protection goes on photo-row status (detached vs live), not on counts.
metadata:
  type: project
---

A quick count's `restore` step (undo of a deleted plain line) deliberately
folds into an identical line that appeared since (test "an undo of a deleted
line folds into an identical line that appeared since"). So the plain count a
restore finds is allowed to differ from what the write left, and an
"expected count" field on the inverse would retire that behaviour.

**Why:** NEO-431 adversarial pass showed a replayed `restore` duplicates
copies; the tempting fix (expected plain count on the inverse) contradicts the
fold-on-restore rule. The page cannot replay (one undo at a time, "Undone."
replaces the notice; Convex delivers a mutation once), so a bare replay is a
hand-made API call against the caller's own box and is accepted.

**How to apply:** guard a photo restore by the photo rows' status in
`reattachPhotos` (a named photo of the caller's that is already `live` means
the inverse was applied, or is forged: refuse). Leave `set`/`remove` guards
per line, and never key an undo refusal on the box's plain count.
