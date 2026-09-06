---
name: silent-refusal-and-stale-control-patterns-neo251
description: NEO-251/252 findings — silent-refusal fields erasing typed input with no announcement, a shared radiogroup extracted verbatim across two conflict types, and a breadcrumb that survives an auto-hop and silently bounces back
metadata:
  type: project
---

## Silent-refusal commit-on-blur fields (CardPairingModal.tsx) — recurring pattern, watch for it elsewhere

This codebase has a reducer convention ("players.ts convention", per its own
comments) of REFUSING an over-length/over-count edit rather than trimming it —
correct, since trimming silently stores something other than what was typed.
But the convention as originally implemented was ALWAYS silent: the reducer
returns the same state object (a documented, tested no-op) and the CALLER
(`finishEdit` for card-name RENAME, `commitPlayersDraft` for the NEO-251
roster field) unconditionally closed the editor / cleared the draft on commit,
regardless of whether the reducer actually applied the change. Net effect: the
operator types a valid-looking, over-length value, presses Enter or tabs away,
and their typed text simply vanishes with **zero feedback**, sighted or not —
a real WCAG 3.3.1 Error Identification defect, not just an AT-only gap.

Fixed (this audit) by pre-checking the same bounds in the CALLER before
committing: on a violation, don't clear the draft/close the editor, set a
`{key, message}` error state scoped to that row, and render a `role="alert"`
span next to the field wired via `aria-describedby`. For a field that can lose
focus on the refusing path (blur/tab-away, unlike Enter which
`preventDefault()`s), add a ref callback that force-refocuses when
`document.activeElement !== el` and this row's error is set — CardPairingModal
already had exactly this trick on the card-name editor's autofocus-on-mount
ref; reuse it rather than inventing a new mechanism.

**When auditing any "commit-on-blur, reducer silently no-ops on invalid input"
field in this codebase, check whether the caller distinguishes "no-op because
unchanged/blank" (fine, nothing lost) from "no-op because refused" (needs an
announced error) before clearing draft state.** They frequently don't.

Also found in the same pass: a native `maxLength` HTML attribute applied to a
`|`-joined MULTI-name field, sized to the PER-NAME limit — this silently
truncates a valid short roster of 2-3 players well before the real per-name/
per-count bounds are ever reached, with no message. If a field holds a joined
list, `maxLength` sized for one list item is wrong; enforce list-shaped bounds
in the commit handler instead (with an announced error, see above) and drop
the native attribute.

## `ConflictRadioGroup` (CardPairingModal.tsx) — verbatim extraction pattern, verified

NEO-251 extracted the pre-existing NEO-189 name-conflict radiogroup into a
shared `ConflictRadioGroup` component and reused it for a new roster conflict,
explicitly to avoid "two radiogroups that behave differently under arrow keys"
drift. Verified byte-identical DOM for the name-conflict path by diffing
against `origin/main`'s literal className/role/aria-checked/tabIndex strings —
they matched exactly. This is the right way to verify an "extracted verbatim,
audit the byte-identity claim" comment: diff the ORIGINAL file's JSX strings
against the shared component's render, not just read the new comment and trust
it. Roving tabindex + arrow-wrap generalizes cleanly over N options (tested at
2 and 3) via `options.findIndex` + modulo — no special-casing needed when a
third "Custom" option is added mid-session.

## `role="status"` notice pattern — one instance already right, one instance missing it

Two structurally identical "a marketplace side will be skipped / the pane
moved on its own" notices exist in this feature: `AttachSetsDialog.tsx`'s
`Pane`'s `notice` prop (already `role="status"`, done correctly by the
original author) and `MultiSourcePanel.tsx`'s `SideColumn`'s `skipNote` (was a
plain `<p>`, NO role — found and fixed in this audit, NEO-252 review). Both
appear/disappear in response to an action (detaching a chip, an auto-hop) that
moves focus elsewhere (a parked heading, nowhere), so a plain paragraph is
never announced. When this codebase has near-duplicate notice-style UI split
across two components for two marketplaces/panels, check that BOTH have the
same ARIA treatment — one having it right is not evidence the sibling does.

## Stale control surviving an auto-hop (AttachSetsDialog.tsx, NEO-252)

`AttachSetsDialog`'s BSC pane auto-hops from `variants` to `sets` when the
path names no linked BSC set (`bscNoSetNote` set, `bscSetSlug` still
`undefined`). The breadcrumb rendered in that state was computed independently
of the reason for being there: `shownSetLabel = bscSetLabel ?? ownSetLabel`
falls back to the NB variant's own label when there's no linked BSC set — so
it read "Back to <NB set label>" and was fully clickable, and clicking it
re-fetched `variants` with no `setSlug`, got the same no-linked-set answer
back, and bounced straight back to `sets` (wasted call, loading flash,
re-announced notice, and for a keyboard/AT user a control that visibly does
nothing). Fix: gate the breadcrumb itself on the same condition that caused
the hop (`bscNoSetNote !== null && bscSetSlug === undefined`) and render
nothing rather than a plausible-looking dead control. **General lesson: when a
view auto-navigates in response to a state flag, audit every OTHER piece of
chrome on the destination view (breadcrumbs, back buttons, tab labels) for
whether it was written assuming a human chose to be there — an auto-hop is a
state the chrome's authors likely never considered.**

See also [[neonbutton-contrast-defect]], [[focus-park-pattern]],
[[live-region-role-pattern]] for related conventions in this codebase.
