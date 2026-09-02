---
name: live-region-role-pattern
description: The correct way this codebase makes an always-mounted status/error region switch urgency, and the one place it was done wrong
metadata:
  type: patterns
---

Convention for an always-mounted live region whose role needs to flip between
`status` (routine) and `alert` (error), seen correctly in
`apps/web/app/print/placeholders/intake.tsx`'s upload notice:

```tsx
<div
  key={notice?.tone ?? "idle"}                              // forces remount on role change
  role={notice?.tone === "error" ? "alert" : "status"}
  aria-live={notice?.tone === "error" ? undefined : "polite"} // let role=alert's implicit assertive live region do the work
  aria-atomic="true"
>
```

Two things matter and are easy to get backwards:

1. **`role="alert"` already implies an assertive live region.** Explicitly
   also setting `aria-live="polite"` on the same element contradicts it — some
   AT/browser combinations will honor the explicit `aria-live` over the role's
   implicit value, silently downgrading an error to a non-interrupting
   announcement. Set `aria-live` to `undefined` (not `"polite"`) whenever
   `role` is `"alert"`.
2. **A `role` attribute change on an already-mounted node doesn't reliably
   re-trigger AT announcement** in every browser/AT pairing — some cache the
   live-region politeness at the moment the node entered the accessibility
   tree. The `key={...}` swap forces React to unmount/remount the node so the
   AT sees a fresh live region with the new role from the start.

**Bug found doing this wrong** (NEO-152 audit, 2026-08-26):
`apps/web/app/print/placeholders/dropzone.tsx`'s file-selection status paragraph
had `role={problem ? "alert" : "status"}` but hardcoded `aria-live="polite"`
unconditionally, and no `key` — i.e. exactly the two things intake.tsx's own
notice region gets right, missing on the sibling component one file over. Fixed
to match the intake.tsx pattern exactly. When auditing a live region here,
diff it against intake.tsx's notice as the reference implementation rather than
evaluating it in isolation — this is a pattern the codebase already has right
in one place, and the failure mode is simply not copying it everywhere the same
shape appears.

Also worth checking: does an interactive list/grid have success confirmations,
not just error ones? A `role="alert"` region for failures is not sufficient by
itself if successful actions restructure the DOM (items moving between lists)
with no live region narrating what happened — see [[focus-park-pattern]] for
where this was also missing in `review-grid.tsx`.

## `CardChecklist.tsx`'s `syncMessage` banner — fixed (NEO-203 follow-up, 2026-09-01)

Initially flagged in the NEO-203 `sync-review-modal.tsx` audit but left
unfixed because that pass was scoped to the modal file only. A follow-up
scope expansion allowed editing `CardChecklist.tsx` and this was fixed to
match the intake.tsx pattern above. Two things worth remembering about how it
was done, since the state shape here didn't already carry a tone the way
`intake.tsx`'s `Notice` type does:

- The pre-existing `syncMessage` state was a bare `string | null`, set from
  ~10 call sites across the file. Rather than touching every call site to
  build a `{tone, text}` object inline, the state was renamed to `syncNotice`
  (`{text, tone: "status" | "error"} | null`) and a **thin wrapper** kept the
  old name and 1-arg call shape: `setSyncMessage(text, tone = "status")`. Only
  the ~6 call sites that report a genuine failure (guard clauses, catch
  blocks, `!result.success`, `Commit failed: ...`) pass the second `"error"`
  argument; everything else (the success "Saved N cards." summary, the
  unknown-players/teams prompt, the two "cancelled" messages) needed no change
  at all. This is a reusable trick for retrofitting the tone pattern onto an
  existing plain-string message state without a large diff.
- **The literal-hex fix from `sync-review-modal.tsx` did NOT transfer here.**
  That modal is always-dark (no `dark:` variants anywhere in it), so
  `text-[#FF2EB3]` on a low-opacity `bg-[#FF2EB3]/NN` could be tuned once
  against one known background. `CardChecklist.tsx`'s own container is
  `bg-white dark:bg-gray-800` — genuinely bi-themed — and pink text at any
  tint measures under 4.5:1 against both a near-white light background (best
  case ~2.9:1) and this file's actual `gray-800` dark one (~4.0:1 at the same
  /10 that passed in the modal). The fix that actually holds in both themes:
  Tailwind's `pink-*` scale, paired exactly the way this same file's
  pre-existing `blue-*` status box already is (`bg-pink-100
  dark:bg-pink-900/30 border-pink-300 dark:border-pink-700 text-pink-800
  dark:text-pink-200`) — measures 6.7:1 light / 10.1:1 dark. **Lesson:** a
  contrast fix computed for one component's actual (single-theme) background
  chain is not portable to a different component just because it shares a
  brand color — recompute against the ACTUAL background(s) that component
  renders against, especially when `dark:` variants are in play.
