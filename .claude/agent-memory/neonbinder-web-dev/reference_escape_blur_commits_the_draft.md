---
name: escape-blur-commits-the-draft
description: In a commit-on-blur draft field inside a modal, Enter/Escape must act IN PLACE (no blur) — blur() drops focus to <body> outside aria-modal and fires onBlur synchronously with the stale draft; never key the field by its prefill
metadata:
  type: reference
---

Pattern in apps/web edit-in-place fields (ReconciliationModal ReadySetRow
title, SlSetReviewModal NameField, MultiSourcePanel label): local draft,
`onBlur={commit}`.

Two traps, both found in NEO-325:

1. `el.blur()` in an Enter/Escape handler. It dispatches onBlur
   **synchronously** with the current render's closure (so Escape's
   `setDraft(original); blur()` commits the abandoned edit), AND it drops
   focus to `<body>` — outside an `aria-modal` dialog (a11y re-audit S2).
   House fix now: Enter calls `commit()` directly, Escape calls
   `setDraft(original)` + `onDraftChange(null)`; neither blurs, focus stays.
   A later blur (Tab away) commits again and finds nothing to do. The old
   `revertingRef` guard is gone. Make `commit` trim the draft in place
   (`if (next !== draft) setDraft(next)`) so the later blur is a no-op.

2. `key={prefill}` on the field. When the committed name IS the next prefill
   (SlSetReviewModal `names[slId]`), every commit remounts the input and
   focus is lost. Sync instead with the adjust-state-during-render pattern
   (`const [shown, setShown] = useState(prefill); if (prefill !== shown)
   { setShown(prefill); setDraft(prefill); }`) — passes react-hooks lint.

Verify with a focused input: `el.focus()`, `fireEvent.keyDown(el, {key})`,
then `expect(document.activeElement).toBe(el)` and the parent's onRename.

Related: [[reference-live-validation-without-keystroke-renders]].
