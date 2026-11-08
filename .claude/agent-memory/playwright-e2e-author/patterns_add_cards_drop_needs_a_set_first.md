---
name: add-cards-drop-needs-a-set-first
description: NEO-452 — an Add cards drop waits in a browser tray until the run has a set (and a price/condition for a listing box); every spec that drops files calls pickIntakeSet first; which set to pick
metadata:
  type: pattern
---

Since NEO-452 a drop on Add cards with no set picked never uploads: it sits in a
tray ("N photos waiting. Pick a set and they're off."), no run starts and no
`?run=` appears. A spec written before it (e.g. NEO-446's zip/over-limit specs)
that drops straight after picking the binder waits forever on `?run=`.

- Call `pickIntakeSet(page)` (`support/collection.ts`) after the binder/box pick
  and before `intakeDropzone(page).setInputFiles(...)`. A Main binder needs only
  the set; a box that lists also needs a Min price and condition.
- Which set: a spec whose photos never reach Matching (refused, all-rejected,
  a lone side that never pairs) picks the seed's 2024 Topps Chrome Base
  read-only and is listed under "Read-only consumers" in SET-REGISTRY.md. A spec
  whose pair must MATCH a card needs a hand-made per-attempt set holding that
  card (`hres-`, `intk-`), with `pickIntakeSet(page, target, { under: "Insert" })`.
- A zip's send writes no "Sent" status line (the job row speaks); loose photos
  get "Sent N photo(s)." once the set makes the run ready.

Related: [[add-cards-run-start-caps]]
