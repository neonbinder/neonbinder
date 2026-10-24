---
name: collection-store-ui-neo358
description: Recurring a11y defects in the collector page (app/collection/final) after the data-store move - focus loss when a clicked control unmounts, toggle buttons whose name carries state, label-in-name gaps, stacked loading status notes
metadata:
  type: project
---

Patterns found auditing NEO-358 (app/collection/final/**). Check these first on the next collector-page change.

- **Focus loss on unmount is the dominant defect.** The collector views have no focus-park: Remove / Save copy / Cancel in CardDetail, QuickAdd's commit and choice buttons, a Suggestions chip that sets an entity, "Back to the search", "Show the cards" (aria-expanded only ever false, button replaced by pips), a Wall Tile that a Needs filter swaps for an aria-hidden span, the drawer's native-disabled up/down at list ends. NeedList.gotIt is the one correct reference (park on next sibling, else heading).
- **Toggle buttons that carry state in the name too**: Wall Tile (aria-pressed plus "have/need" in aria-label, and click may open details so pressed lies), WallStrip (aria-expanded plus Fold up / Show the X tiles), SetPicker ("Building X" label over "Build it / On the board" text). Stable name plus aria-pressed/expanded only. Compare Checklist "Building this set" (correct).
- **Label in name (2.5.3)**: "Show the {name} cards of {set}" vs visible "Show the cards"; "Show the {name} tiles" vs "Show the tiles"; "Building X" vs "Build it". Insert words in the visible phrase, do not rewrite it.
- **Mutually exclusive aria-pressed chips** (Wall filter, Click-a-tile-does, Checklist Show, EntityResults Which teams, OwnedShelf rail) are house-rule radiogroups; Chip is a shared p3 primitive, so report once, not per call site.
- **Loading status**: LoadingNote is role=status inserted with text (silent in many SRs per notice.tsx's own comment) and stacks with an existing role=status in the same view (FindCard/ChecklistsTab/Suggestions fire up to three at once; Cascade one per column). Fix by one status per view.
- **Range preview** text (QuickAdd, Checklist) is neither live nor tied to the input; invalid range has no aria-invalid/describedby (3.3.1).
- NoticeLine auto-dismisses its Undo at 10s (NOTICE_MS) with no pause on hover/focus (2.2.1); now guards real writes.
- Card drawer open state is component state, not URL (house nav rule); stepping up/down changes the card silently.
- Good: Skeleton uses motion-safe, tokens are themed (theme.css), CardDetailPanel blank-title refusal reuses useReactiveField error + FieldFeedback + aria-describedby correctly.
