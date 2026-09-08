---
name: patterns-pill-radiogroup
description: The house roving-tabindex pattern for a row of pill <button>s marked up as role=radiogroup/role=radio in apps/web, and the four defects that recur every time a new one is written
metadata:
  type: project
---

# Pill radiogroups (`role="radiogroup"` over a row of `<button>`s)

This shape keeps appearing in `components/SetSelector/` because **a `<select>` is
forbidden**: maestro-web gives every `<option>` synthetic tap bounds from its index
inside its own parent and resolves a tap by scanning `document.querySelectorAll('option')`
for the first bounds match, so with more than one `<select>` on screen only the first in
document order is reachable and a tap meant for the second silently mutates the first.
Every one of these surfaces renders over a page that already has selects. So the answer to
"this should be a dropdown" is always **no** — fix the keyboard model instead.

## The reference implementation

`components/SetSelector/CardPairingModal.tsx` (~line 1894, the name-conflict group) is the
house pattern. Copy it rather than inventing:

- `onKeyDown` on the **group** element handles `ArrowLeft/Right/Up/Down`, `preventDefault()`,
  wraps modulo the option count, and **moves selection with focus** (APG single-select).
- `tabIndex={checked ? 0 : -1}` on each radio — one Tab stop for the whole group.
- After choosing, refocus by **re-querying** `[role="radio"][tabindex="0"]` inside a
  `requestAnimationFrame`, never by a captured element ref or index: the newly-checked
  radio only carries `tabindex="0"` after the host's state change has committed.
- The pills stay real `<button type="button">`s with native `disabled` (project tests
  assert `.disabled === true` while the host is busy).

Applied a second time in `components/SetSelector/NewTeamForm.tsx` (NEO-236, League pills),
where the model is built as an ordered `leaguePills` array so the JSX, the roving tabindex
and the arrow handler all read one source of truth.

## The four defects that recur in every fresh instance

1. **`role="radiogroup"` written without the keyboard model.** Every pill an ordinary
   focusable button = one Tab stop per option and dead arrow keys. The ARIA role is a
   promise about the keyboard (SC 2.1.1 / 4.1.2), not just about the announcement.
2. **The focus indicator declared only on the unselected branch.** The house pill style is
   `focus:outline-none` + `focus:border-<neon>` inside the *unpicked* ternary arm — so
   focusing the **picked** pill, whose border is already that neon, changes nothing at all
   (SC 2.4.7). Fix: one ring on both arms —
   `focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900`
   (matches `BaseRoleControl.tsx`, same directory).
3. **`border-gray-700` on the unselected pill.** 1.72:1 on `bg-gray-900`, 1.42:1 on
   `bg-gray-800` — the boundary of an unchecked control is effectively invisible
   (SC 1.4.11). `border-gray-500` is 3.67:1 on gray-900 and clears the 3:1 floor.
4. **`px-2 py-0.5 text-xs` = 22px tall.** Clears 24x24 only via the SC 2.5.8 spacing
   exception (`gap-1.5` = 6px puts centres >24px apart). `py-1` makes it 26px and stops it
   depending on the gaps. Cheap; just do it.

## Non-defects, so don't re-flag them

- A radiogroup with **nothing** checked is valid ARIA. Give the *first* option `tabIndex={0}`
  so the group is still reachable by Tab.
- A plain text `<span>` label sitting inside the `role="radiogroup"` element (the visible
  "League" caption) is an authoring nit, not an SC failure. Restructuring the flex container
  to move it out risks the layout for no compliance gain.
