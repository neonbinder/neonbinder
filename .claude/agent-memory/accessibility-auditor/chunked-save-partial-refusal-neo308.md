---
name: chunked-save-partial-refusal-neo308
description: NEO-308's chunked Group Parallels save (loop of ≤200-row mutation calls) — how a mid-loop refusal's RESET-then-re-INIT interacts with focus-park and the role=alert refusal, and the momentary empty-list render it causes
metadata:
  type: patterns
---

`ParallelGroupingModal.tsx` (NEO-308) splits Save into sequential chunk calls
(`chunkGroupingPlan`, demotions → reparentings → promotions, each ≤ the
server's per-call cap). A refusal after ≥1 chunk landed can't just show the
error over stale pending state — the landed chunks are already committed
server-side, so `handleConfirm`'s catch does `dispatch({type:"RESET"})` (drops
`hasInitialized`) while the modal stays open; a pre-existing `useEffect`
re-`INIT`s from the live `tree` on the next tick, which now includes the
landed chunks. See [[focus-park-pattern]] for the house convention this had
to extend.

**Why the focus-park effect had to change:** `RESET` zeroes `totalChanges`,
which flips Save's *native* `disabled` (`disabled={isLoading ||
totalChanges === 0}` — separate from the `aria-disabled` used while
`confirming`). A focused control that goes natively `disabled` gets blurred
to `<body>` by the browser during that render's commit. The updated effect
(keyed on `confirming` going false) now treats "focus is on Save AND Save is
disabled" the same as "focus is on body," and sends it to the dialog
container (`overlayRef`, same target `Clear` already uses) instead of trying
`saveRef.current.focus()` on a control that is now unfocusable.

**Traced, not runtime-verified:** `setError(message)`, `dispatch({type:
"RESET"})` and `setConfirming(false)` all happen synchronously in the same
catch/finally with no `await` between them, so React's automatic batching
should commit them together — meaning Save's `disabled` flip and
`confirming` going `false` land in the **same** render, and the effect never
sees an intermediate state. If that assumption is ever wrong (a wrapping
unbatched update, a React version change), the effect could fire one render
early against a still-enabled Save. Worth a real NVDA/VoiceOver pass against
a forced second-chunk rejection before trusting this further.

**A real but minor gap found:** `overlayRef`'s element (`role="dialog"`,
`tabIndex={-1}`) has `outline-none` in its className with no
`focus-visible:` replacement — see [[patterns_modal_dialog]] point 2, which
already flagged this shape. NEO-308 didn't introduce it (the mount-open
effect and `Clear` already focus this same invisible target), but it adds a
**third** trigger that lands a keyboard user on an unstyled focus point
(WCAG 2.4.7). Fix once for all three call sites: add a `focus-visible:`
outline to the overlay div, or retarget all three at a real visible-focus
element (e.g. the `h2#parallel-grouping-heading`, given a `tabIndex={-1}` and
its own ring class, the same fix `session-heading` used).

**A side effect of RESET-then-re-INIT via two separate effects, not one
dispatch:** between the RESET commit and the INIT effect's follow-up commit,
`state.rows` is briefly `emptyState`'s empty `Map`, and the body only gates
on `isLoading` (`tree === undefined`), not on `hasInitialized` — so the
grouping list itself renders with zero rows for one commit before repopulating.
No live region narrates row count today, so this is a visual flash, not a
4.1.3 failure — but it means any future "no parallels yet" empty-state
message with `role="status"` would falsely announce during this gap. If that
gets added, gate it on `hasInitialized` too, not just `isLoading`.

The `role="alert"` refusal text itself is unaffected by any of this: it's
component state (`useState`), not reducer state, sits in a stable ternary
slot in the footer (swaps in for the promotion/demotion counts, not a
separate conditionally-mounted sibling), and the INIT effect's dispatch never
touches it — so the alert mounts once per refusal and isn't remounted or
blanked by the rebuild underneath it.
