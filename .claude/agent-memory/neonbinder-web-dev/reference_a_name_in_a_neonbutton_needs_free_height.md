---
name: a-name-in-a-neonbutton-needs-free-height
description: A NeonButton whose label is a row's name spills because Radix fixes the HEIGHT (no nowrap); className recipe per size, no NeonButton change; how to prove it without an E2E
metadata:
  type: reference
---

Radix `.rt-BaseButton` sets `height: var(--base-button-height)` (size 1 =
24px, size 2 = 32px) and `flex-shrink: 0`, but NOT `white-space: nowrap`. A
long name wraps its text yet the box stays one line tall, and an unbroken
token (no spaces) widens the button past its column and the page.

Fix with className only (Radix is in a layer under the utilities, see
[[reference_radix_button_box_beats_tailwind]]):

- size 2: `h-auto min-h-8 max-w-full py-1.5 wrap-anywhere` (+ `text-left` in a list)
- size 1: `h-auto min-h-6 max-w-full py-1 wrap-anywhere`

`min-h` + `py` equal the Radix height on one line (line-height 20px / 16px),
so short labels look unchanged. Use `wrap-anywhere`, not `break-words`: only
`anywhere` also shrinks min-content, so the token cannot widen a flex/grid
ancestor. Prior uses: NEO-424 wizard Link primary, RealAddCardsTab pair button,
sync-status "See everything for", NEO-499 pick-shared list.

Proof when no spec can reach the state: a unit test pins the classes (red
without them), and [[static-markup-visual-check]] renders the real NeonButton
markup through `renderToStaticMarkup` under `<Theme>`, then a Playwright
script (createRequire on apps/web) at a 375 viewport reads each button's
`getBoundingClientRect()` and `document.documentElement.scrollWidth`. Before
the NEO-499 fix scrollWidth was 1073 at 375; after, 375.
