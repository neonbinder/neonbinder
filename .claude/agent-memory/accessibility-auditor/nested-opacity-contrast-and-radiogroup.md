---
name: nested-opacity-contrast-and-radiogroup
description: How to compute contrast through chained /NN opacity backgrounds in this codebase, plus the mutually-exclusive-pill-button → radiogroup pattern found in CardPairingModal (NEO-189)
metadata:
  type: patterns
---

## Chained `bg-*/NN` opacity composites — compute in order, not against the page background

Seen in `CardPairingModal.tsx`'s Matched-list rows: an `<li className="bg-gray-800/60">`
sits inside the modal box (`bg-gray-900`, opaque), and then a "chosen/unchosen"
pill button inside that `<li>` uses `bg-cyan-900/60` / `bg-gray-700/60`. The
button's real rendered color is NOT cyan-900 or gray-700 blended straight
against gray-900 — it is blended against the `<li>`'s *already-blended*
background. Compute front-to-back:

1. `li_bg = blend(gray-800, gray-900, 0.6)` → `rgb(25,34,49)`
2. `button_bg = blend(cyan-900 (or gray-700), li_bg, 0.6)` → `rgb(23,60,79)` (cyan) / `rgb(43,53,68)` (gray)

Then run WCAG contrast between the button's own text color and `button_bg`, and
separately between `button_bg` and `li_bg` if a 1.4.11 non-text/boundary check
is warranted. Skipping the intermediate step (composing straight against the
outermost opaque background) understates how dark/muted these translucent
layers actually get once nested two or three deep — always walk the actual DOM
ancestor chain for `bg-*/NN` before computing.

Measured for this component (Tailwind default `gray-800/900/700`, `cyan-900/100`):
li_bg `rgb(25,34,49)`; pink text `#FF2EB3` vs li_bg = **4.79:1** (passes, but
barely — recompute if the palette or opacity value ever changes); pink vs the
section-header's plain `gray-900` background = 5.32:1; `cyan-100` text on the
chosen-pill's composited background = 10.45:1; `gray-300` on the unchosen
pill's composited background = 8.41:1. All of those text-contrast numbers
passed here — the actual defect was elsewhere, see below.

## `#FF2EB3` literal hex vs `tailwind.config.js`'s `neon-pink` (`#FF2E9A`) — still both live

[[contrast-reference]] already flagged this split. Confirmed again here:
`apps/web/CLAUDE.md` documents Cancel/Warning as `#FF2EB3`, and this
component's new NEO-189 markup uses the literal arbitrary value
`text-[#FF2EB3]` / `border-[#FF2EB3]` — NOT the `neon-pink` Tailwind token
(`#FF2E9A`). Both hexes are genuinely in use in different places (token vs.
arbitrary literal); this is a pre-existing design-system inconsistency, not
something introduced by or in scope for a feature-level audit. When computing
contrast, use whichever hex the component under audit ACTUALLY wrote in its
className — do not assume it resolves to the `neon-pink` token's value.

## Two-button `aria-pressed` used for a mutually-exclusive, always-one-chosen pair → convert to `radiogroup`/`radio`

`aria-pressed` is for an independent on/off toggle. When a UI has exactly two
(or more) options where exactly one is always the current choice — e.g.
"which marketplace's name wins" — the correct ARIA pattern is WAI-ARIA APG's
radio group: an outer `role="radiogroup"` (with its own accessible name, e.g.
`aria-label="Name for #227c"`, and optionally `aria-describedby` pointing at
explanatory text) wrapping `role="radio"` + `aria-checked` items with a roving
`tabIndex` (0 on the checked item, -1 on the rest) and an `onKeyDown` on the
group that moves BOTH focus and selection together on Arrow keys (per APG,
arrow-key navigation in a single-select radio group changes the selection as
it moves focus — it is not just a focus move). `aria-pressed` gives no
enforced guarantee of mutual exclusivity and no arrow-key relationship between
the two controls; `role="radio"` does both for free. The fix can keep the
existing pill-button visual styling entirely — only the `role`/`aria-checked`/
`tabIndex`/keydown semantics change, not the DOM shape's look.

Also caught alongside this in the same audit (NEO-189, 2026-08-29):

- **1.4.1 Use of Color**: the chosen-vs-unchosen fills for this exact pattern
  (`bg-cyan-900/60 text-cyan-100` vs `bg-gray-700/60 text-gray-300`) differ in
  relative luminance by only ~**1.06:1** once composited over their container
  — i.e. hue is the ONLY thing distinguishing "selected" from "not selected"
  for a sighted operator; a colour-vision-deficient user cannot tell them
  apart. Fix: add a non-colour cue on the chosen state — a `✓` glyph (wrapped
  `aria-hidden`, since `aria-checked`/`role="radio"` already announces the
  state to AT) plus a `ring-2 ring-[#00B7FF]` (the app's Accent blue — 7.0:1 /
  5.1:1 against the two backgrounds involved here, comfortably clears 1.4.11's
  3:1 for a non-text state indicator).
- **2.5.3 Label in Name**: the original `aria-label`s
  (`Use the BSC name "X" for #N`) did NOT contain the visible button text
  (`BSC: X`) as a substring — a real, easy-to-miss failure whenever a hand-
  written `aria-label` fully replaces rather than extends the visible text.
  Check this explicitly any time a button has BOTH visible text AND an
  `aria-label` that isn't just that same text with a little context appended.
  Fix pattern used here: put the exact visible label first, then append
  context with an em dash — `` `BSC: ${name} — use this name for #${cardNumber}` ``.
- **Focus after a state-creating action**: when clicking control A causes
  control A to unmount (moves to a different list) AND simultaneously
  surfaces a brand-new decision UI (the radiogroup) for the first time, don't
  just apply the existing [[focus-park-pattern]] (park on a stable neighbour)
  — send focus INTO the new decision UI instead (the first/default radio),
  since that is exactly what the operator needs to act on next. Query it by a
  stable data attribute keyed on domain identity (e.g.
  `data-name-conflict={cardNumber}`), not by array index or a captured ref,
  if the surrounding list re-sorts after every dispatch (as this one does via
  `ordered()`).

All five fixes here shipped with `role="group"` kept as an OUTER wrapper
(nesting `radiogroup` inside it) specifically to avoid rewriting an existing,
already-passing test suite's `getByRole("group", {name: "Name conflict on
#N"})` assertions — nesting a more specific role inside a coarser one it's
consistent with is a fine way to add semantics without a churny rename.
