---
name: patterns_solo_fetch_missing_park_on_start
description: NEO-255's inline solo-fetch progress line restores focus to the Sync button when the run ENDS but never parks it when the run STARTS — the immediate disable-triggered blur-to-body that focus-park-pattern.md already documents was missed for the one new code path with no dialog to catch it
metadata:
  type: patterns
---

`apps/web/components/SetSelector/CardChecklist.tsx` (NEO-255, "skip the Match
Cards dialog when only one marketplace is attached") is the first place in
this file where clicking Sync does **not** mount any dialog at all — the
inline `soloFetch` progress line (`role="status"` span + "Cancel" button,
~line 1907) takes its place. The PR's author clearly knew about this
codebase's [[focus-park-pattern]] convention — `restoreSyncFocusRef` (line
544) and its effect (~654-667) faithfully restore focus to the Sync button
once the run ends (commit lands, cancel fires, or the stream times out — all
three paths, and all three are unit-tested for it).

**What was missed: the *other* half of the pattern.** `disabled={busy}` on
the Sync button (unchanged, pre-existing line ~1714) blurs focus to
`<body>` the INSTANT `setSyncing(true)` runs — before the network call even
starts, per `focus-park-pattern.md`'s "immediate" failure moment. On every
OTHER path through this file, a dialog (`CardPairingModal`) mounts in the
same click and grabs focus back via its own mount-time
`requestAnimationFrame(() => cancelBtnRef.current?.focus())`
(`CardPairingModal.tsx:1900`), closing the gap in under a frame. The solo
path mounts no dialog, and nothing replaces that rAF grab — so for the
entire fetch (up to `SOLO_STREAM_TIMEOUT_MS` = 30s, longer if it succeeds),
keyboard/AT focus sits on `<body>`. The live region still announces
(doesn't need focus), but a keyboard user who wants to reach the inline
Cancel button has to Tab from the top of the document instead of it being
next in sequence — exactly the class of bug `focus-park-pattern.md` and
[[raf-focus-park-race]] already catalog, just the first instance of it in
THIS file.

**The fix, matching the established convention exactly:** give the
`soloFetch` container `<div>` a `ref` + `tabIndex={-1}`, and add a `useEffect`
keyed on `soloFetch` transitioning null→non-null that parks focus there,
guarded on `document.activeElement === document.body` (per
[[raf-focus-park-race]] — don't fire unconditionally). This also incidentally
fixes the "Cancel is hard to reach via Tab" problem, since Tab from the
parked container lands on Cancel next.

**Lesson for future audits of this file:** every one of this component's many
dialogs mounts a focus-grab on open (`restoreFocusRef` prop + the modal's own
mount effect). Any NEW branch that intentionally skips mounting a dialog
inherits `disabled={busy}`'s blur-to-body for free and needs its OWN
park-on-start effect — the existing `restoreSyncFocusRef` end-of-run pattern
is necessary but not sufficient.

## Other things checked and found correct in this same diff (NEO-255, 2026-09-07)

- **Label-in-name (2.5.3):** `aria-label="Cancel checklist fetch"` on a button
  whose visible text is "Cancel" — passes. The accessible name *starts with*
  the visible text (an append, not the substitution [[label-in-name-async-swap-pattern]]
  flags), so SC 2.5.3's "contains, case-insensitive" test is satisfied.
- **Contrast:** the `soloFetch` banner reuses the file's pre-existing
  `bg-blue-100 dark:bg-blue-900/30 ... text-blue-800 dark:text-blue-200`
  status-box classes verbatim (same as `syncNotice`'s non-error tone,
  already vetted in [[live-region-role-pattern]]). Measured `text-blue-800`
  on `bg-blue-100` ≈ 7.15:1; `text-blue-200` on `blue-900` composited at 30%
  opacity over the file's `bg-gray-800` container ≈ 9.45:1. Both clear 4.5:1
  comfortably; the Cancel button inherits the same color (no override) so it
  passes identically.
- **Target size (2.5.8) — genuine new failure.** The Cancel button
  (`shrink-0 rounded-sm font-semibold underline decoration-dotted
  hover:decoration-solid`, no `py-*`/`px-*` at all) sits in a `text-sm`
  (20px line-height) flex row with no vertical padding → ~20px tall target,
  under the 24px floor. This is the exact "bare text-link-styled `<button>`
  with zero `py-*`" shape [[target-size-2.5.8]] already documents (that
  file's `SyncDoneNotice.tsx` Dismiss button, same failure, fixed with
  `py-1.5`). No exemption applies: it's a standalone control in a flex row
  (not inline text), not spacing-isolated from anything that would justify
  the spacing exception. This file's OWN `syncNotice` CTA button
  (`attentionCount` "Fix them one at a time") uses the identical class
  string but is exempt under the **inline** exception — it's appended
  directly into the `{syncNotice.text} <button>...` running sentence, not a
  standalone flex-row item — so don't assume the two are the same case just
  because the Tailwind classes match.
