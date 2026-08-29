---
name: target-size-list-rows
description: icon-only disclosure/toggle buttons in SetSelector row components tend to have no padding, failing WCAG 2.2 SC 2.5.8
metadata:
  type: project
---

Found in `CardChecklistItem.tsx`'s NEO-189 variation disclosure toggle: a
`<button>` with no padding/sizing classes wrapping a `text-xs` caret glyph
(▸/▾). Rendered hit area was roughly the glyph's own box — well under WCAG
2.2 SC 2.5.8's 24×24 CSS px minimum (Level AA).

**Pattern for the fix, compatible with fixed-width-slot virtualization
constraints:** this row reserves a fixed-width `<span>` slot for the toggle on
*every* row (even ones without variations), specifically so a row's rendered
width never depends on whether the button is present — that's load-bearing
for Virtuoso (a per-row width/height change re-measures the virtualized list).
Bumping the reserved slot itself from `w-5` (20px) to `w-6 h-6` (24px, applied
uniformly to every row regardless of content) — and sizing the button to fill
it (`w-6 h-6 flex items-center justify-center`) — satisfies the target-size
minimum without reintroducing conditional per-row sizing. The visual glyph
stays small; only the hit area grows.

**When auditing this codebase:** check any icon-only button inside a dense
list row (`CardChecklistItem.tsx` and siblings under `SetSelector/`) for
padding/explicit sizing — the existing "Edit"/"Del" text buttons in the same
file (`px-1.5 py-0.5 text-xs`) are also likely under 24×24 and predate this
audit; not fixed here (out of scope for a feature-scoped pass) but worth
flagging if touched again.
