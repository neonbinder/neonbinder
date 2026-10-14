---
name: reference-review-walk-holds-for-open-controls
description: Entity-review wizard walk — `pinnedRowHasEdits` only gates the teams-first yield; an open list/search/form on the presented row must also feed `rowInteractionOpen` (resolveNav `interactionOpen`), which holds BOTH yields
metadata:
  type: reference
---

The review wizard's implicit pin (`resolveNav` in `components/SetSelector/entity-review-nav.ts`) yields two ways: teams-first (`hasSettledUndecidedTeam`) and steps staged under the row (`waitingOnStagedTeams/Leagues`). `pinnedRowHasEdits` gates ONLY the first, on purpose: a blocked row with edits still moves on. NEO-341 added `interactionOpen` (wizard: `rowInteractionOpen`), which defers BOTH while a control is open on the row. Before that, a lookup settling elsewhere unmounted the open sport chooser under the pointer on a phone, and the click was lost.

**How to apply:** any new popover, listbox, inline form or search on the presented row keeps its open state locally. It must report up through `onOpenChange`: emitted on transitions via a ref (like CareerTeamEntry's `onDirtyChange`), and also `false` on unmount while open. The wizard stores it as the ROW id (`sportChooserOpenFor`, `undatedFormOpenFor`) so a report that outlives its row can't hold the next one. Add it to `rowInteractionOpen`. That also defers the auto-add timer, through `pinnedEditsRef`.

When wrapping an existing `A || B` clause in a new `!flag && …` guard, parenthesise the whole `A || B`. `&&` binds tighter, so leaving it bare silently guards only `A`. The new unit tests caught exactly that.
