---
name: linking-uis-are-drag-and-drop
description: Any "these two lists describe the same things" pairing/linking UI must be drag-and-drop, and must say so on screen — Jason's operator feedback on NEO-189 / PR #205
metadata:
  type: feedback
---

When a screen asks the operator to link one item to another (marketplace set to
marketplace set, card to card, insert to parallel), the gesture is
**drag-and-drop**, and there must be a visible one-line instruction naming the
gesture, placed **above** the lists — not below them, where it falls past the
fold on any real-sized list.

**Why:** Jason, testing PR #205, on CardPairingModal's click-to-select-then-click
linking: *"this isn't how we normally highlight things for action in the app and
nothing indicates that. We use drag and drop everywhere else for this kind of
linking we should be doing the same here."* He then doubled down on the hint
specifically: *"we also need something on screen that tells the user that they
should be doing that there."* So the complaint is two separate defects — the
wrong gesture, AND an affordance that was never announced. Fixing only the
gesture does not close it.

**How to apply:** Building or reviewing any pairing/reconciliation UI in
`components/SetSelector/` (or anything shaped like it) — reach for dnd-kit and
follow the precedent modals rather than inventing a selection protocol. Keep the
click path alongside it: it is the keyboard/assistive-tech path and the one
Maestro drives, so drag is an addition, never a replacement. Show the hint
whenever the columns render with anything in them, not only when a link is
currently possible — a lone unmatched card is when someone is most stuck.
