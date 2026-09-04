---
name: contrast-patterns
description: Known-bad and known-good Tailwind color pairings against this app's dark surfaces, with computed contrast ratios
metadata:
  type: project
---

Computed (WCAG relative-luminance formula) against this codebase's actual
surface colors — re-verify if a component introduces a new bg tone.

## Fails WCAG 1.4.3 (4.5:1, normal text) — do not use

- **`text-gray-500` (#6B7280) on `bg-gray-900` (#111827)** — ratio ≈ 3.67:1.
  This is the single most common contrast bug in this codebase: `gray-500` is
  reached for by habit as "secondary/muted text" but only clears 3:1 (fine for
  a 3:1 non-text/icon use, e.g. an `<svg>` icon fill, never for a text node).
  Found and fixed in NEO-219 across `BaseSetPicker.tsx` (4 sites: "BSC/SportLots
  returned no base set…", "No matching sets found", the footer status hint) and
  `EntityColumn.tsx` (3 sites: the "Checking where this name is already used…"
  transient status, the cross-parent-duplicate confirm's secondary lines).
- **`text-gray-500` on `dark:bg-gray-800` (#1F2937)** — ratio ≈ 3.03:1, even
  worse. Same fix.
- White text on **`NeonButton cancel`** (bg `#FF2E9A`) — ratio ≈ 3.44:1. This is
  [[neonbutton-cancel-contrast]] — a pre-existing `components/modules/NeonButton.tsx`
  default, not something to patch inline in a consuming file.

## Passes — safe replacements

- **`text-gray-400` (#9CA3AF) on `bg-gray-900`/`bg-gray-800`** — ratio ≈ 7.0:1.
  The drop-in fix for a fixed-dark surface (a `createPortal` dialog like
  `BaseSetPicker.tsx` that never renders in light mode) — just swap
  `gray-500` → `gray-400`, no `dark:` variant needed.
- **`text-gray-600` (#4B5563) on white, paired with `dark:text-gray-400` on
  `dark:bg-gray-800`** — ratio ≈ 7.55:1 / 6.99:1. The fix for a component that
  legitimately supports BOTH themes via Tailwind's `dark:` variant (see
  `EntityColumn.tsx`'s inline "Add Custom Entry" form, which uses
  `bg-white dark:bg-gray-800`) — this exact pairing was already used once in
  that same file ("Fetching from marketplaces…", `text-gray-600 dark:text-gray-400`)
  before NEO-219 copied the transient-status paragraph into two new stages
  without carrying the `dark:` pairing along. Match the existing in-file
  convention rather than guessing at a new one.

## A structural gotcha worth knowing before assuming "dark mode never applies"

`tailwind.config.js` has no `darkMode` key, so Tailwind's `dark:` variant
defaults to `media` (`prefers-color-scheme`) — it is **not** tied to Radix
Theme's `appearance="dark"` (set in `src/main.tsx`), which only themes Radix's
own components. So a component's `dark:` Tailwind classes activate purely on
the *browser's* OS-level color-scheme preference, independent of the app's
own forced-dark Radix chrome. Do not assume "the app is dark-only, so `dark:`
classes are dead code" — they really do toggle, on some viewers' machines,
and a component that mixes `bg-white dark:bg-gray-800` really can render as a
white box in an otherwise-all-dark UI depending on the OS. When auditing,
check contrast for BOTH the light and dark resolution of any `dark:` pair.
