---
name: intake-demo-vs-real-sibling-neo369-382
description: The card intake exists twice (a public demo tab on a scripted sim and the real signed-in tab); the real one fixed on-focus dialogs, focus-only single-key shortcuts, status chatter and focus parks that the demo still has. Also the kbd-in-button name trap.
metadata:
  type: project
---

`app/collection/final/intake/AddCardsTab.tsx` + `ui.tsx` (NEO-369, the demo on
the public binder-tracking page) and `RealAddCardsTab.tsx` (NEO-382, signed in)
are siblings built a day apart. Audit both whenever either changes; in the
2026-11-01 full review every demo finding had already been fixed on the real tab:

- **3.2.1 On Focus**: the demo opens its review `Overlay` from `onFocusCapture`
  when `needsDrawer(item)`; the real tab only selects on focus and opens from
  click / `o` / Review. A modal that mounts on focus is a Level A failure and
  blocks Shift+Tab through the lane.
- **2.1.4 Character Key Shortcuts**: a window `keydown` listener that acts on
  a *selected* id (state) fires wherever focus is. The compliant shape (real
  tab) resolves the row from `target.closest("[data-intake-tile]")`, so the
  keys are "active only on focus"; drawer keys are scoped to `[role=dialog]`.
- **Status chatter**: a `role=status` sentence that embeds live counts
  announces every pipeline tick even when the author's comment says the
  numbers are not live. Say one phrase while anything is in flight and the
  counted sentence once settled.
- **Save-all disables itself**: native `disabled={matched === 0}` on a button
  whose own click empties `matched` drops focus to body; park on the next tile
  or the lane heading (`focusTile`) in the same handler.
- **`aria-pressed` for a single selection** (one lit tile per screen, no
  un-press) is a role/state lie; a genuine two-pick toggle (the loose pile) is
  the correct use.
- **Escape inside a nested picker** must `stopPropagation()` or the
  `Overlay`'s own Escape closes the whole drawer in the same keystroke.

## `<kbd>` inside a button corrupts the name

`<button><kbd className="mr-1">s</kbd>Swap sides</button>` names as
"sSwap sides" (inline concatenation, no space): 2.5.3 fails and
`getByRole("button", { name: "Swap sides", exact: true })` cannot find it.
`aria-keyshortcuts` already exposes the key, so the `<kbd>` should be
`aria-hidden="true"`. Grep `<kbd` inside any `<button>`/`NeonButton` body.
