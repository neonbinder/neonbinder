---
name: radix-button-box-beats-tailwind
description: Radix Themes styles.css is unlayered, so Tailwind v4 utilities (in @layer) lose to it on Radix Button/NeonButton — display, height, padding, radius, font-size
metadata:
  type: reference
---

`src/main.tsx` imports `@radix-ui/themes/styles.css` unlayered while Tailwind v4 puts utilities in `@layer utilities`, so any property Radix's `.rt-BaseButton` / `.rt-Button` sets wins over a Tailwind class regardless of specificity: `display: inline-flex`, `height` (per size: 1=24px, 2=32px, 3=40px), `padding`, `border-radius`, `font-size`, `gap`.

**Why:** found migrating hand-rolled buttons onto NeonButton (NEO-356). `lg:hidden`, `rounded-full`, `px-4`, `text-lg` on a NeonButton silently do nothing.

**How to apply:** on NeonButton / any Radix Button, use only properties Radix leaves alone (margin, width, `min-h-*` for touch targets, position/`absolute`, translate, shadow, flex-1, self-*). For responsive hiding wrap it in `<span className="contents lg:hidden">`; for a circle use `radius="full"` plus inline `style`; to stretch to a sibling's height use `style={{ height: "auto" }}`. A link that should look like the button uses `<NeonButton asChild><Link/></NeonButton>`. Related: [[radix-scale-overrides-lose-to-radix]], [[unlayered-css-beats-tailwind-utilities]].
