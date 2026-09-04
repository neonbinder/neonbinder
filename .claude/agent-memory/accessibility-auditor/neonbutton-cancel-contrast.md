---
name: neonbutton-cancel-contrast
description: NeonButton's `cancel` variant (white text on #FF2E9A pink) fails WCAG 1.4.3 at ~3.44:1 — a design-system-level issue, not fixable per-call-site
metadata:
  type: project
---

`components/modules/NeonButton.tsx` (not itself audited/touched by NEO-219 —
last modified in #205, pre-dates that PR) renders its `cancel` variant as
white text (`color: white`) on `backgroundColor: "#FF2E9A"`. Computed contrast
≈ 3.44:1, below WCAG 1.4.3's 4.5:1 floor for normal-size button text (Radix
`Button` default size renders ~14px, not "large text", so the 3:1 large-text
exception does not apply).

This is exercised by essentially every destructive confirm in the app,
because `cancel` is the app's convention for "the button styled in the danger
color" — including, as of NEO-219, three NEW confirm surfaces:
- `components/modules/confirm-dialog.tsx`'s primary (destructive) button
  always uses `<NeonButton cancel>` for the confirming action (e.g. "Yes,
  delete" in `SetAttributesPanel.tsx`'s one-sanctioned-delete flow) — despite
  the `cancel` name, it is the CONFIRM button, not Cancel; `cancel` here is
  purely a color-variant name, not a semantic role. The real Cancel button in
  that same dialog uses `secondary` (blue, `#00C2FF`), not `cancel`.
- `BaseSetPicker.tsx`'s footer Cancel button (`<NeonButton cancel onClick={onClose}>`).
- `EntityColumn.tsx`'s custom-entry form Cancel/Back buttons.

**Do not fix this by editing `NeonButton.tsx` during a scoped audit** — it is
shared by every `cancel`-styled button across the whole app, so changing its
color is a visual-regression-risk, product-design decision that needs sign-off,
not a drive-by a11y patch. Flag it as a Major finding and recommend a
follow-up ticket against the design system; do not silently skip it either —
it is real, it does fail AA, and it is getting MORE exposure with every new
confirm dialog this pattern is used for.

Possible fixes for that future ticket: darken the pink background slightly
(the project's own `#FF2EB3` used elsewhere is close but not meaningfully
better — recompute before picking a value), or switch to black text on `cancel`
the same way the default (green) variant already uses black text on a bright
background.
