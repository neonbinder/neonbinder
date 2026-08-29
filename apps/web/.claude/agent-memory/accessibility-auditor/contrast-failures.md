---
name: contrast-failures
description: measured WCAG 1.4.3 contrast failures for specific hex/Tailwind combos used repeatedly across NeonBinder's UI
metadata:
  type: project
---

Computed against WCAG's relative-luminance formula (not eyeballed). Re-verify
if the underlying hex/background tokens ever change.

## `#FF2EB3` (brand "Cancel"/neon-pink) as **text** on light surfaces

Used throughout `components/SetSelector/*` for error/destructive text
(`text-[#FF2EB3]`), e.g. `CardDetailPanel.tsx`'s discard/unlink affordances
and — pre-fix — the NEO-189 "Variation of" error paragraph.

- On white (`bg-white`): **3.34:1** — fails the 4.5:1 minimum for normal text.
- On `dark:bg-gray-800` (#1F2937): **4.4:1** — also fails (just under 4.5:1).

This is a **systemic, pre-existing** app-wide issue (confirmed present in
`main` before NEO-189, e.g. the "listing title over 80 chars" warning and the
cross-listing "Unlink" button text) — not something to spot-fix piecemeal
everywhere it appears. When *adding new* text in this color for something that
must be legible (an error message in particular), don't propagate the failing
hex — use a same-hue, AA-passing substitute instead:
`text-[#C2178A] dark:text-[#FF6FCB]` (measured 5.55:1 on white, 5.87:1 on
`dark:bg-gray-800`). This was applied to the new NEO-189 variation-parent error
text as a scoped fix; flag the broader pattern for a design-system-level pass
rather than re-fixing it file by file.

## `text-gray-400` (#9CA3AF) as body/label text on white

Used pervasively as the muted-label/helper-text color across `CardDetailPanel`
and siblings (`text-[10px] uppercase ... text-gray-400`, `text-xs text-gray-400`).

- On white: **~2.54:1** — well under 4.5:1.
- On `dark:bg-gray-800`: comfortably passes (dark-mode variants of this
  pattern are generally fine; it's specifically the light/white-background
  case that fails).

Also systemic and pre-existing, spanning far more of the codebase than any one
audit should try to fix. `text-gray-600 dark:text-gray-300` is a safe
same-intent substitute (~7.56:1 on white, ~9.97:1 on `dark:bg-gray-800`) — used
for a new NEO-189 status message rather than reusing `text-gray-400`.

**When auditing:** don't re-derive these every time — cite the numbers above.
Do re-derive for any *new* hex/background combo, since neon-on-dark is often
fine but the same neon on white/light or mid-tone frequently is not (per the
project's own audit brief).
