---
name: copy-photo-specs
description: NEO-431 copy-photo spec handles - held vs saved photo box, how to prove a photo loads without evaluate, which drawer state Details opens on /inventory
metadata:
  type: reference
---

The photo box (`CopyPhotosField.tsx`) is one widget in three places: a line's Edit form (saves on pick), the drawer's Add form (held until Add) and Request a card (held until Send). Handles shared by all: region `Photos`, file inputs by label `Front photo file` / `Back photo file`, link `Front of <line>, full size (opens a new tab)`, buttons `Remove front`, `Replace front`, `Swap front and back`. The `<line>` is `your new copy` (Add form), `this card` (Request) or the line name (`Raw, Excellent`, with `×2`, `, in <home>, line N` when twins).

- A HELD photo's link href is a `blob:` address; a saved one is `/copy-photo/<32 hex>/image` (thumb `/thumb`). That difference is the perceivable-ish proof that "nothing saved yet".
- No role/name handle says an image decoded. `support/collection.ts` `expectPhotoServed(page, locator, "src"|"href")` fetches the address a new tab would open and checks an image comes back. Use it instead of `evaluate` + `naturalWidth` (the older copy-photos spec still has the evaluate form).
- On /inventory Checklists, `Details for <card>` opens the drawer ALREADY EDITING the card's one box line (so the thumb is replaced by the form's photo box); with no line it opens "Add a copy". On /collection the Details button opens the plain list view; a click on the row text opens it editing.
- NEO-431 rule: a photo alone does not set a line apart for the quick count (field reads 1, no "also here"); an Add with photos never folds (`keepsOwnLine`); a + stacks onto the photo line only when every plain line has photos.

**Why:** the first draft of the inventory spec asserted the thumb after reopening the drawer and would have failed on the editing state.
**How to apply:** when a spec reopens a drawer from an inventory row, expect the Edit form and read photos from its box.
