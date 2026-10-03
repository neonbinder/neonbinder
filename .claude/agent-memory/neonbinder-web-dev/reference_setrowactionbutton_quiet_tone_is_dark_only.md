---
name: setrowactionbutton-quiet-tone-is-dark-only
description: SetRowActionButton's `quiet` tone is gray-200 text for the always-dark attributes panel; the checklist card is `bg-white dark:bg-gray-800` (Tailwind dark is OS-media-based even though Radix is forced dark), so a quiet chip there vanishes in a light OS theme — use NeonButton with the same behavioural contract
metadata:
  type: reference
---

`components/SetSelector/SetRowActionButton.tsx` has two tones. `attention`
(amber) follows the theme; `quiet` is `text-gray-200` + `ring-offset-gray-900`,
correct only on the attributes panel, which is dark in both themes.

The app forces Radix `appearance="dark"`, but Tailwind's `dark:` variant is
the OS `prefers-color-scheme` media query, so every `bg-white dark:bg-gray-800`
surface (the card checklist, its notice banners) is WHITE for a light-OS
visitor. A quiet chip there is gray-200 on white.

**How to apply:** when asked to "use the SetRowActionButton pattern" for a
control on the checklist card, take the CONTRACT, not the component: text is
the name (no aria-label), `aria-busy`/`aria-disabled` never native `disabled`,
`activateOnEnter`, `inert` while its ConfirmDialog is up with focus restored in
an effect, a stable `id` for `pressKey`. Draw it as the `NeonButton` that sits
in that slot (NEO-312's `ParallelBuildButton` replacing Sync). Say so in the
report, since the ask named the component.

Related: [[inert-the-opener-behind-confirmdialog]], [[an-inert-trigger-still-names-a-button]].
