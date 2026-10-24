---
name: collection-checklist-total-and-drawer
description: /collection (NEO-358) spec facts - how to prove the checklist total against rendered rows, what a missing stored count looks like on screen, and the drawer's URL/Back/width behaviour
metadata:
  type: reference
---

Collection checklist total ("Have 0 of T"):
- T is the row's stored non-variation count (`nonVariationCardCount`), read by `collection.variantCompletion`; the cascade's Base option shows the same number from `collectionCatalog.drill` as "N cards".
- The checklist LISTS every card including photo variations (their Details name ends `, <x> variation`), and its count status reads `N cards` for ALL of them. So T = listed - variation rows, not listed.
- A missing stored count is invisible on screen while the hand tally fits its budget (4000 cards): the fallback is the same computation, so equality assertions catch a stale or swapped count, never "missing". A count the server cannot tally reads "N owned" (total 0), which breaks any `Have 0 of` read.
- Nothing owned yet means one `Details for ...` button per card, so `toHaveCount(listed)` proves the list finished rendering before a count is taken.

Card drawer (`Overlay` drawer variant):
- `detail=<cardId>` is pushed on open (Back closes it, the checklist stays); `mode=add` only from a row's "Add another <short name>" button, which passes no list, so that route has NO "Card i of n" status. Open with Details to assert the status.
- Width: `w-full max-w-[95vw]` under 640px, `sm:w-[40rem]` above. Phone = ~95% of the viewport; desktop 1024 = ~62%.
- The dialog's accessible name comes from the h2's aria-label (the card's full label), not its visible text.

See also [[read-a-row-name-with-aria-snapshot]].
