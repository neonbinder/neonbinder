---
name: search-box-is-not-a-content-signal
description: Since NEO-224 every open set-builder column renders its `Search <x>` box from its first frame (loading/empty/full), so its presence no longer means ">8 rows"/"sync done" — gate on the column listbox having an option, or type-then-wait for the filtered row; typing first races the auto-opened reconcile dialog
metadata:
  type: feedback
---

Before NEO-224 `EntitySelector` rendered its search box only above 8 rows, and
many gates used "the Search box is visible" as the CONTENT gate. NEO-224 made the
box unconditional (it is the column's combobox and the cascade's focus target), so
those gates pass in the first frame of a cold fetch and the next row click dies on
its timeout.

**Why:** a gate that passes before the thing it waits for is a false gate; the
seed (`setup.spec.ts`) is the costliest place to have one.

**How to apply, the replacement signals:**
- the column's LISTBOX (`getByRole("listbox", { name: "<Column title>" })`) holds at
  least one `option`: EntitySelector renders the listbox only when the column has
  at least one row;
- type the target name FIRST (the filter survives rows landing), then assert the
  filtered option is visible; for an alternation with a dialog use `.or()` and type
  a PREFIX so the box's own value can never satisfy the row locator;
- **typing first races an auto-opened dialog.** At Insert/Parallel level the
  auto-sync opens ReconciliationModal the moment both fetches return; it focuses
  its own root on mount and restores focus on close, so keys typed in that window
  vanish and the box comes back focused but EMPTY. Guard the `fill` by asserting
  the dialog is not open, and after the save re-fill only if the box is empty
  (`toHaveValue("")`);
- Manufacturers only (its listbox always holds the pinned All Brands entry):
  positive pinned-entry gate, then assert the idle empty text is hidden;
- "no search box means short column" fallbacks are dead code now, but first check
  what other outcome their guard caught
  ([[dead-branch-guards-can-cover-a-second-outcome]]).
Related: [[reference_neo255_one_marketplace_surfaces]].
