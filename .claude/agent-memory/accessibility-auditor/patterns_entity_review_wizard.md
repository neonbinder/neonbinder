---
name: patterns-entity-review-wizard
description: EntityReviewWizard.tsx dialog-level Escape handler interacts dangerously with any child component that unmounts its own focused node; verified NEO-254 contrast failures and native-disabled slip
metadata:
  type: project
---

# `EntityReviewWizard.tsx`'s dialog-level Escape handler will close the WHOLE
# wizard if focus has silently fallen to `<body>` — check every child form for this

`EntityReviewWizard.tsx`'s outer dialog has one Escape handler on `dialogRootRef`
(around line 1104): it calls `isEditableTarget(e.target)` and returns early only
when the CURRENT focus target is a text-ish control; otherwise it treats Escape
as "throw the whole review away" (`requestClose()` — instant discard if
`decided === 0`, else opens the confirm-discard dialog). This is deliberate and
documented (NEO-220): every child field is expected to swallow its OWN Escape
with `e.stopPropagation()` so the dialog only ever sees an Escape that was
genuinely aimed at the modal.

That contract silently breaks for any child component that (a) opens an inline
form conditionally-mounted inside the dialog, (b) lets the user close it via
Escape/Cancel/Save, and (c) does NOT explicitly return focus somewhere after
closing. When such a form's focused element (an input or the Save/Cancel
button itself) unmounts, the browser drops focus to `document.body` — standard
behavior when a focused node leaves the DOM. The NEXT Escape keypress then has
`e.target === document.body`, `isEditableTarget` returns false, and the dialog
closes/discards the entire review session. Two keystrokes (Escape to dismiss a
small inline form, Escape again out of habit) can blow away the whole wizard.

Confirmed live in **`components/SetSelector/UndatedCareerTeams.tsx`** (NEO-254):
its inline "Add years" form (`{openFor === name && (<div role="group">...)}`)
has `close()` (line ~88) that only does `setOpenFor(null)` — no focus restore.
The Save/Cancel buttons (~lines 219-234) and the Escape handlers on the two
year `Input`s all lead there. Rated **Critical**, not just an isolated focus-
order nit, specifically because of this cascading Escape interaction — check
the surrounding dialog for exactly this global Escape contract before rating a
"focus not returned on close" bug as merely Major in this file family.

**Fix pattern**: capture the trigger element (or its name) when the form opens
— `onClick={(e) => open(name, e.currentTarget)}` storing the button in a ref —
and call `.focus()` on it inside `close()` (and after a successful `save()`).
This mirrors the exact anti-pattern this same file already calls out and
avoids elsewhere in its own code (~line 1565: "A ternary that swaps WHICH
element renders here unmounts the focused node and focus falls to `<body>`" —
solved there by keeping one element with props that vary, not by a focus
restore, but the underlying hazard is identical).

See also [[patterns-modal-dialog]] for the general WAI-ARIA dialog checklist,
and [[patterns-forms-and-contrast]] for the contrast numbers below.

# NEO-254 contrast/consistency findings, script-verified

- `text-gray-500` keeps recurring as this codebase's #1 contrast failure, now
  confirmed in TWO more places on the `EntityReviewWizard` gray-900 family:
  `SameNamePlayerPanel.tsx`'s "Nothing on file yet" (composited panel bg
  `#102032` — a 5% `#00B7FF` tint over `#111827` — barely moves the number:
  3.41:1) and `UndatedCareerTeams.tsx`'s "Add the years and it joins the
  career list..." hint paragraph directly on `#111827` (3.67:1). Both fail
  1.4.3. Swap to `text-gray-400` (6.49–6.99:1 in these exact spots).
- `admin/PlayerManagement.tsx`'s new "Also on Wikidata, no years yet" list's
  **Remove** button uses native `disabled={busy !== null}` where the file's
  own sibling code (and both new `SetSelector` components) use
  `aria-disabled` + a guarded `onClick`. This is the one clear violation of
  the repo's stated "aria-disabled, never native disabled, so a busy round-
  trip doesn't eject a keyboard user from the tab order" rule found in the
  NEO-254 diff — the adjacent "Add years" button in the same list has NO
  disabled guard at all (functional inconsistency, not just cosmetic).
- `UndatedCareerTeams.tsx`'s `disabled` prop only reaches the "Add years"
  trigger button — the open form's Save/Cancel buttons and both year
  `Input`s have no `aria-disabled`/`disabled` at all, so the wizard's `busy`
  state doesn't actually block them.
