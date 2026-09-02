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

## Another gap found, not yet fixed: `CardChecklist.tsx`'s `syncMessage` banner

`apps/web/components/SetSelector/CardChecklist.tsx` renders its post-sync/
post-commit status text (`"Saved N cards."`, `"Commit failed: ..."`, error
strings, the `unknownPlayers`/`unknownTeams` prompt, etc.) in a plain
`<div>` with **no `role` and no `aria-live` at all** — none of the
`status`/`alert` pattern above. This is real content a screen-reader user
needs (result counts, deletion counts, stale-decision warnings, conflict
counts — all appended dynamically by NEO-203's new `notes` logic in
`runCommit`), and it currently announces nothing. Flagged in the NEO-203
audit (2026-09-01) but **deliberately not fixed there**: that audit's scope
was `sync-review-modal.tsx` only ("do not touch any other files"), and this
div is pre-existing markup in a different file that the audit wasn't
permitted to edit. Still live — check it first before re-deriving this from
scratch. The fix, when someone is allowed to touch `CardChecklist.tsx`, is
exactly the `key`/`role`/`aria-live` pattern above: this message toggles
between routine ("Saved N cards.") and failure ("Commit failed: ...", "Error:
...") content, which is precisely the two-tone case the intake.tsx pattern
was built for.
