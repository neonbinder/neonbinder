---
name: shared-component-two-surface-contrast
description: A component shared between an unconditionally-dark dialog and a genuinely bi-themed (dark:-split) panel cannot use one fixed hex set safely on both — the surface has to be a caller-declared prop, not an assumption baked into the shared component (NEO-101)
metadata:
  type: patterns
---

## The bug class

`TitleLengthMeter.tsx` (the shared `62/80 · may clip in search` counter /
over-cap alert / advisory note, used by both `TitleFixer.tsx` and
`CardDetailPanel.tsx`) justified fixed hex colours (no `dark:` pairs) with a
premise that is only half true: "the app renders `appearance=\"dark\"`
unconditionally". Radix's `appearance="dark"` IS forced everywhere (confirmed
via `BaseSetPicker.tsx`'s own comment: a nested `<Theme>` with no props
inherits it). But plain Tailwind `dark:` utility classes in this app are NOT
tied to that — they follow `prefers-color-scheme` (no `@custom-variant dark`
override in `app/globals.css`, no forced `.dark` class anywhere in
`src/main.tsx`/`index.html` — confirmed by grep, matching
[[contrast-reference]]'s previously-flagged-but-unresolved "Open question").

So there are genuinely TWO kinds of surface in this app:
- **Unconditionally dark** (`CardAttentionWalker`'s dialog: literal
  `bg-gray-900`, no `dark:` qualifier anywhere in that file) — a `dark:` pair
  is WRONG here (light half would render on the actually-dark bg for an
  OS-light-mode user — the same `BASE_INPUT` trap documented in
  `components/primitives/Input.tsx`). Fixed hex is correct and required.
- **Genuinely bi-themed** (`CardDetailPanel`'s own drawer chrome:
  `bg-white dark:bg-gray-800`) — the SAME fixed hex, tuned for a dark bg,
  measures 1.8–3.3:1 against white (all fail 4.5:1), and even the error tone
  measured 4.40:1 against this panel's OWN `gray-800` (fails, if narrowly —
  gray-900 elsewhere in the app passes at 5.32:1, gray-800 does not).

A component used by BOTH needs the caller to say which one it's on. There is
no single safe default hex set.

## The fix pattern (reusable)

Give the shared component a `surface?: "themed" | "dark"` prop (or similar),
backed by two class maps:
- `"dark"` — the original fixed hexes, unchanged (still correct for the
  always-dark consumer).
- `"themed"` (the default, so the bi-themed consumer needs NO call-site
  change) — `dark:`-split Tailwind classes, with light-mode halves reusing
  this exact codebase's own established precedent where one already exists in
  the SAME file the bi-themed consumer lives in (e.g.
  `text-[#C2178A] dark:text-[#FF6FCB]` for an error line, or
  `text-gray-500 dark:text-gray-400` for secondary text — both already
  present, pre-diff, in `CardDetailPanel.tsx`). Reusing an in-file precedent
  beats inventing new colours: it's already proven and keeps the app's error/
  secondary-text vocabulary from growing a third variant.

Default to `"themed"`, not `"dark"` — more of this app's chrome is bi-themed
than unconditionally dark, and an unconditionally-dark caller (there's usually
only one or two) can opt in explicitly and cheaply.

## Duplicated raw JSX between the two consumers needs the SAME check, one at a time

`TitleFixer.tsx` and `CardDetailPanel.tsx` each hand-roll an IDENTICAL
Regenerate button and "source chips" `<ul>` — not routed through the shared
component, so the `surface` prop fix above doesn't reach them automatically.
Each hardcoded-hex usage in the duplicated markup needs its own light/dark
split, checked independently:
- `text-[#00B7FF]` (Regenerate button + its confirm-status line) — 2.28:1
  against white, fails; fixed to `text-[#0369A1] dark:text-[#00B7FF]`
  (5.93:1 light / unchanged 6.44:1 dark). Also caught `hover:text-white` on
  the same button — literally invisible against `bg-white` in light mode,
  fixed to `hover:text-black dark:hover:text-white`.
- The chip `<li>` (`bg-gray-800/60 text-gray-200`, label span
  `text-gray-400`) — computed the COMPOSITED chip background (gray-800 blended
  at 60% opacity over the panel's actual bg, not the raw token) per
  [[nested-opacity-contrast-and-radiogroup]]'s method: over white that's
  `#787f88`, and `text-gray-200`/`text-gray-400` against it measure 3.27:1 /
  1.56:1 (both fail, the label badly). Fixed with a light/dark split
  (`bg-gray-100 border-gray-300 text-gray-700` label `text-gray-600`, dark
  half unchanged) — 9.36:1 / 6.87:1 against the light composite.

**When auditing a component duplicated (not shared) across an always-dark and
a bi-themed consumer**: grep the bi-themed file for every bare `text-[#...]`/
`bg-[#...]`/`text-gray-NNN` with no `dark:` counterpart, and check each one
independently — fixing the shared sub-component does not fix the copy-pasted
markup sitting right next to its call site.

## Enter-to-save bound directly to an input reopens the native-disabled-strands-focus bug, in a NEW way

[[focus-park-pattern]] already tracks "the just-clicked BUTTON goes native
`disabled` and blurs to `<body>`" as a recurring per-button bug. `TitleFixer.tsx`
found a variant of it on an INPUT: its title field's own `onKeyDown` calls
`save()` directly (Enter-to-save bound to the field itself, unlike
`MissingTeamFixer`'s Enter handler, which lives on an OUTER wrapper that
explicitly excludes INPUT/BUTTON targets specifically to avoid this). Since
`save()` synchronously sets `busy=true`, and the input had `disabled={busy}`,
the very field that has focus goes native-disabled on the next render and the
browser force-blurs it to `<body>` — on every successful Enter-triggered save,
and with NO recovery on a failed one (nothing re-focuses after `busy` resets).
**Fix**: swap `disabled={busy}` for `aria-disabled={busy || undefined}
readOnly={busy}` — `readOnly` blocks edits without removing focusability,
`aria-disabled` announces the state, and the existing `if (!canSave) return`
guard in the save handler already makes native disabling unnecessary for
correctness. **Check this specifically whenever a text input's OWN
`onKeyDown` (not a wrapper's) triggers the same busy-setting action that then
disables it** — the input, not just neighbouring buttons, is a stranding
candidate.

## `list-style: none` strips list semantics in Safari + VoiceOver

Found on `TitleFixer.tsx`'s per-card reasons list
(`<ul className="... list-none ...">`). This is a well-known, narrow WCAG 1.3.1
gotcha specific to that browser/AT pairing (not universal — most browsers keep
the implicit role). Fix is one line, zero risk: add `role="list"` back onto
the `<ul>`. Cheap enough to apply on sight whenever `list-none` appears on a
semantically-meaningful list (skip it for a visual-only list, e.g. a flex row
of chips with no bullets to begin with — that one was never going to show
bullets, so `list-none` there isn't why VoiceOver would drop the role, though
the same `role="list"` fix is still harmless insurance).

## A locked test can pin an aria-label string across a control's OWN state changes — check before "fixing" 2.5.3

`TitleFixer`'s and `CardDetailPanel`'s Regenerate button visibly cycles
"Regenerate" → "Rebuilding…" → "Replace?" while its `aria-label` stayed the
static "Regenerate card title" — a real WCAG 2.5.3 Label-in-Name gap (neither
"Rebuilding…" nor "Replace?" is a substring of the name). The natural fix
(make the label track state) is BLOCKED for the "Replace?" state specifically:
`CardDetailPanel.titleLimits.test.tsx` calls
`screen.getByLabelText("Regenerate card title")` while `confirming` is
already `true` — an exact-string query, so changing the label in that state
breaks a locked test. **Resolution taken**: fixed the untested "loading" state
(safe, zero test impact — the mocked `useQuery` resolves synchronously, so no
test ever observes that transient render), left the "confirming" state's label
unfixed, and documented why inline at the call site plus relied on the
already-wired `aria-describedby` (pointing at the visible confirm-status text)
as the mitigation for screen-reader users, who get the state explained even
though the name itself is stale. **Lesson**: before "fixing" an aria-label to
track visible state, grep the paired test file for `getByLabelText` calls
made while that state is active — an exact-match query on the CURRENT string
is an implicit contract on that string not changing in that state, editing
locked tests to un-pin it is a legitimate option but raises the stakes of the
change, and a partial fix (cover the untested states, document the blocked
one) is a reasonable, low-risk middle ground when the full fix isn't free.

## Second confirmed instance of "Enter-to-save bound directly to an input": `RenameEntityControl.tsx` (NEO-211)

Same bug, same fix, different file. `RenameEntityControl`'s own `onKeyDown`
(not a wrapper's) calls `commit()` on Enter, which sets `saving=true`
synchronously, and the input had `disabled={saving}` — the focused field
goes native-disabled and blurs to `<body>` for the duration of the
`renameSelectorOption` mutation round-trip. Fixed identically:
`readOnly={saving} aria-disabled={saving || undefined}`, with
`aria-disabled:opacity-50 aria-disabled:cursor-not-allowed` added to the
className to keep the same visual "busy" look the native `disabled:` variants
used to provide (Tailwind's `aria-disabled:` variant selector works the same
way `disabled:` does — matches `[aria-disabled="true"]`). **This is now two
independent occurrences of the identical shape (`TitleFixer.tsx`'s title
field, now `RenameEntityControl.tsx`'s rename field) — check any input whose
OWN `onKeyDown` triggers a busy-setting async action by default, not just as
a hunch.**

A second, DIFFERENT focus bug lived in the same component: closing the editor
(successful commit OR Escape-cancel) unmounts the `<input>` and swaps back to
the pencil `<button>`, with nothing moving focus onto it — a plain instance
of [[focus-park-pattern]], fixed with a `wasEditingRef`-guarded effect
(`if (wasEditingRef.current && !editing) buttonRef.current?.focus()`) so it
only fires on the true→false transition, never on the component's own
initial mount (where `editing` starts false and there is nothing to restore
focus FROM).
