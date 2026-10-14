---
name: draft-echo-is-not-a-read-back
description: A save confirmation or live preview built from the form's DRAFT state ("Saved <name>", "Shows as: …") proves the save resolved, not what the row holds; prove stored values with a node rendered from the QUERY result after a reload
metadata:
  type: feedback
---

Before citing a confirmation line or preview as proof a value was STORED, read
which variable the component renders it from. Admin detail panels typically keep
two: one composed from the query row (the panel heading) and one from the draft
inputs (preview lines, `Saved ${draftName}.`). Only the first is a read of the
database.

**Why:** NEO-326 removed TeamManagement's "Shows as: <full name>" preview. The
honest answer to "replace every reliance with an equally strong proof" was that
the draft-built lines never proved storage at all. The proof was always the
heading (`teamFullName(team)`) and the master row's accessible name, both re-read
after a reload. A spec comment calling `Saved <name>` "the first read-back of the
split" had overclaimed.

**How to apply:** for a stored-value claim, `page.reload()` (or navigate again),
re-select, and assert a node rendered from the query (heading, row name, list
text). Keep the draft confirmation as the "save resolved" gate only. When a value
is COMPOSED from two fields, also read each half separately (row short name,
Location field via `toHaveValue`): two halves glued into one column compose to
the same full string.
