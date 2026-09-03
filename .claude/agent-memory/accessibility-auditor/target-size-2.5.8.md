---
name: target-size-2.5.8
description: WCAG 2.2's 2.5.8 Target Size (Minimum, 24x24 CSS px) is a NEW recurring finding class in this codebase — small text-xs pills, bare icon buttons and underline links all land under it. Concrete padding fixes measured here.
metadata:
  type: patterns
---

## How to compute the effective hit area without a browser

Tailwind's `text-xs` sets `line-height: 1rem` (16px) regardless of the 12px
font-size — that 16px, plus vertical padding, plus border-width, IS the
button's rendered height (assuming no explicit `h-*`). Add horizontal padding
the same way for width, though width is rarely the failing axis here — these
components all fail on HEIGHT, because `py-0.5`/no vertical padding is a
common "make it look compact" instinct that text-only buttons fall into.

`height = line-height + (padding-y * 2) + (border-width * 2)`

## Found and fixed in `SelectorSyncReviewModal.tsx`'s Accept/Decline pills (NEO-211)

`text-xs px-2 py-0.5 rounded border` → 16 (line-height) + 4 (py-0.5×2) + 2
(border×2) = **22px**, under 24. Fixed by bumping to `py-1` (16+8+2=26px). This
is the shape to grep for: `text-xs` combined with `py-0` or `py-0.5` on an
interactive `<button>`.

## Found and fixed in `SyncDoneNotice.tsx`'s Dismiss button (NEO-211)

`text-xs underline ... px-1` — **no vertical padding at all**, so height is
just the 16px line-height. This is the more severe version: a bare
text-only/underline "button" styled to look like a link is the pattern most
likely to have zero `py-*` at all, because visually it reads as inline text
rather than a control. Fixed with `py-1.5` (16+12=28px, no border on this one
so no border term). **Check every underline/text-link-styled `<button>` for a
`py-*` class at all — a fully absent one is worse than a too-small one and
easy to miss precisely because the element LOOKS like plain text.**

## Found and fixed in `RenameEntityControl.tsx`'s pencil icon button

A bare `<button>` wrapping a `w-4 h-4` (16x16px) icon with **no padding
classes on the button itself** — hit area is exactly the icon's own 16x16,
badly under 24x24 on both axes (this is the one place in this ticket where
WIDTH also failed, not just height, because there's no text to give the
button intrinsic width). Fixed with `p-1` (4px/side → 24x24 exactly). Any
icon-only button with `w-4 h-4`/`w-5 h-5` and no padding is a candidate — grep
for `<Icon className="w-4 h-4"` (or `w-5 h-5`) with no `p-*` on the
surrounding `<button>` in the same file.

## Not a hard blocker at "just barely 24px" — but don't round down

22px and 20px both failed here; the fixes landed at 24-28px rather than
exactly 24px, on purpose — box-sizing/line-height rounding across browsers can
shave a fraction of a pixel, and there's no value in fixing a 2.5.8 finding by
landing exactly on the boundary. Prefer a fix with a few px of margin over the
minimum unless space is genuinely tight.

## No exemption applied in any of these three cases

2.5.8 has three exemptions worth checking before treating a small target as a
defect: **inline** (a target inside a sentence/block of running text — not the
case for any of these, all are standalone controls in a flex row), **spacing**
(a 24px circle centered on the target doesn't overlap a neighbour's — the
Accept/Decline pair sits at `gap-1` (4px), nowhere near enough spacing to
qualify), and **essential** (a specific presentation is legally/functionally
required — none of these are). When none of the three apply, the padding fix
is simply correct; don't spend time arguing for an exemption that doesn't fit
the shape of the control.
