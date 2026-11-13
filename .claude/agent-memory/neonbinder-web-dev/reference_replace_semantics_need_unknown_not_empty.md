---
name: replace-semantics-need-unknown-not-empty
description: A client that sends a REPLACE list (absent = untouched, [] = clear) must model "links not loaded" as unknown, never as []; otherwise an attach drops every link it could not see
metadata:
  type: reference
---

Pattern from NEO-496 (checklist section links on Reconcile rows and the Base).
A mutation arg with replace semantics (`checklistSectionKeys?: string[]`:
absent leaves the row alone, present replaces, `[]` clears) is only safe if the
client knows the row's CURRENT list before it adds to it.

**Why:** seeding "no data came back" as `[]` reads exactly like "this row has
no links". The first attach then sends `[new]` and silently deletes the old
links — a rule-5 (linkage is maintained) bug no test catches unless it asserts
the unknown case.

**How to apply:**
- Keep three states per row: known-with-links, known-empty, unknown (a flag on
  the row, e.g. `checklistLinksUnknown`). A server list that omits rows with no
  links is "known-empty" for them only when the list itself is present.
- Unknown rows: refuse the attach in the reducer AND hide the attach control,
  with a line saying why; never send the arg for them on save.
- Known rows: send the arg only when the list changed from what was loaded
  (set compare), so an untouched re-save writes nothing. Echo keys you cannot
  resolve unchanged rather than filtering them out.
- Test the unknown case explicitly (attach refused, save omits the arg).
