---
name: reconcile-save-goes-through-the-leave-step
description: Reconcile Save may open "Leave N sets unpaired?" (NEO-339); press it through saveReconcile, which reads the Pending headings first; insert-level auto-matches can be withheld when the SportLots set is unsorted in the brand review
metadata:
  type: reference
---

Never click `Save N sets` by hand in a Reconcile dialog. Whether the step opens
is decided by the dialog's own Pending columns (every BSC set + SportLots sets
inside the default prefix filter, whatever the search boxes show), so the
helper clears the boxes, unchecks "Show all SportLots items", reads the
`BSC (n)` / `SportLots (n)` headings, then asserts the step or the direct save.
The step's rows read the raw value: SportLots twins lose their `(#id)` suffix
there.

Insert-level auto-matches whose SportLots set is still unsorted in the brand's
SportLots review arrive as two Pending halves, so a spec asserting
`Ready (1 of N)` on an unsorted-review brand needs a both-shapes gate
(inserts-1996 pairs them by hand in that case).

The "+ Custom" form folds names by case only, but Group Parallels folds
punctuation too, so a tie fixture is `Y` + `Y.`, never `Gold` + `gold`.
