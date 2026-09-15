---
name: slate-border-contrast-on-slate-900
description: Measured WCAG 1.4.11 contrast of Tailwind slate/gray border tones on the slate-900 dialog panel — slate-800 1.22:1, slate-600 2.4:1 (fails), slate-500 3.7:1 and gray-500 3.7:1 (pass); reach for slate-500 when a border is a control's boundary
metadata:
  type: reference
---

Contrast ratios of Tailwind default palette border tones against `bg-slate-900`
(`#0f172a`, the ConfirmDialog panel):

| tone | ratio | 3:1 (SC 1.4.11) |
|---|---|---|
| slate-800 | 1.22:1 | fail (effectively invisible) |
| slate-700 | ~1.7:1 | fail |
| slate-600 | ~2.4:1 | fail |
| slate-500 | ~3.7:1 | pass |
| gray-500 | ~3.7:1 | pass (TeamPicker's dark-theme trigger border precedent) |

**Why:** an audit finding on NEO-279 proposed `border-slate-600` as the fix for
a 1.22:1 ledger border; computing it showed slate-600 is still under the 3:1
floor. The house precedent (TeamPicker, `dark:border-gray-500`, documented
inline as 3.67:1) is the pair that actually passes.

**How to apply:** a border that is a focusable region's or control's visible
boundary on the slate-900/gray-900 panel needs slate-500/gray-500 or lighter.
Purely decorative row dividers are not held to 3:1, but slate-800 on slate-900
is invisible and should not be used for them either; slate-600 is the visible
decorative choice. Compute rather than trust a "one step lighter" suggestion.
