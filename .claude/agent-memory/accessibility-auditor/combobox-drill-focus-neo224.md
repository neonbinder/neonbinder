---
name: combobox-drill-focus-neo224
description: NEO-224 set-builder drill columns as combobox+listbox — what held up (contrast of highlight ring, aria-controls wrapper) and the focus-loss and silent-status gaps found
metadata:
  type: project
---

- A cascade-level "focus the deepest open column" effect keyed on column identity does NOT re-run when the operator re-picks the ALREADY-SELECTED row of a re-expanded column (key unchanged, and the terminal rule is latched on the selection). The focused input unmounts, focus drops to body. Fix lives in the column: treat `id === selectedId` as a collapse and set the chip-focus flag. Enter right after a chip re-open is exactly this path (highlight seeds on the selection).
- `role="status"` with only an `aria-label` and no text content announces nothing; a live region must carry text, and be mounted before the text changes. Put loading copy in the page's always-mounted status line.
- Typing a filter changes the option count with no announcement (no-match text is a plain div). Needs an always-mounted sr-only polite region per column.
- aria-controls pointing at a roleless wrapper is ARIA 1.2 non-conformant but harmless for an always-visible inline listbox; activedescendant carries the semantics. Note-level.
- Inset ring emerald-700 (light) / #00D558 (dark) vs every column -100/-900 selection fill: all 4.49-5.57:1 (worst blue-100 4.49, green-900 4.59). Passes 1.4.11 with margin.
- `html` has `scroll-padding-top: 80px` (globals.css) for the fixed header, so `scrollIntoView({block:"nearest"})` and browser focus scroll already clear it.
