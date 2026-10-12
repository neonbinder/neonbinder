---
name: store-working-copies-hide-renames-from-db-guards
description: storeReconciledOptions/storeSelectorOptions defer every patch to a write pass, so a guard that reads ctx.db mid-loop cannot see a rename earlier in the same call; applySelectorSyncSuggestions patches in-loop and can
metadata:
  type: reference
---

The two stores keep `Working` copies per row and patch only in the final
write pass (`pendingPatchFor`). Any helper that reads `ctx.db` inside the item
loop (e.g. a sibling scan in a rename guard) sees the rows as they were when
the call began, not the batch's earlier title edits. `workingSiblings()` is
the in-call view; pure planners like `planValueRename` take it as an argument.

`applySelectorSyncSuggestions` is different: it patches inside its loop, so a
db-reading guard there DOES see earlier accepts (Convex mutations read their
own writes).

**How to apply:** when wiring a db-reading guard into a store loop, either feed
it the working state or accept fail-closed behaviour for same-call changes and
say so in the comment; let the planner's working-sibling clash catch two lines
asking for the same name. See [[store-loops-fall-through-to-insert]].
