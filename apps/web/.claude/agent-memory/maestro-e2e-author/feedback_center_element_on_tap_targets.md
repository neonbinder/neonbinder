---
name: centerElement true on every scroll to a tap target
description: Maestro best practice — any scrollUntilVisible whose target you then tapOn must use centerElement true; reconciled with the don't-scroll-in-viewport CDP rule
type: feedback
---

Maestro best practice (per the Maestro docs): whenever a `scrollUntilVisible`
brings an element into view that you then intend to **tap**, set
`centerElement: true`. Prefer it over `visibilityPercentage` for tap targets.

**Why:** The 1024×629 headless viewport has a footer that paints over the body's
overflow region and absorbs clicks near the bottom. A `scrollUntilVisible`
without centering can leave the target at the viewport edge (top under the fixed
nav, or bottom in the footer-steal zone y≳489) — Maestro finds the DOM element
and "taps", but React's onClick never fires, so the modal/drill silently never
opens. Centering puts the target at ~y=315, clear of both. Proven repeatedly:
PR #31 Sets-row footer-steal (every PASSED tap landed y≤457, every FAILED tap
y≥489); the NEO-46 "Group Parallels" open button clipped at the right edge. It
costs nothing when the target is already centered and removes a whole flake class.

**How to apply:**
- Any `scrollUntilVisible` whose element is later `tapOn`-ed (same element) →
  add `centerElement: true`; drop `visibilityPercentage` on those steps.
- Scroll-to-ASSERT steps (target is only asserted, never tapped) do NOT need it —
  leave them to minimize churn on passing flows.
- Corollary (does NOT conflict): if the tap target is reliably already IN the
  viewport (short/empty columns, a 0-item column's "+ Custom" idle button), prefer
  a NON-scrolling `extendedWaitUntil visible`/`assertVisible` instead of scrolling
  at all — that also dodges the CDP scroll-bug. See
  [[reference_cdp_scroll_bug_and_badge]]. centerElement is for when you genuinely
  must scroll to reach a tap target.
- Applied across move-parallels-of-inserts-custom.yaml (the three "Add custom
  Inserts" adds, the "Group Parallels" open, and the post-save "^Stars$" tap).

NOTE: centerElement alone does NOT fix data-instability failures. If an element
is *found and then disappears* mid-flow (e.g. the whole drill collapses), that is
a data wipe/churn under concurrency, not a scroll-position problem — centering
won't help. Reproduce the flow in isolation (single worker) first: if it passes
solo but fails in the sharded run, the cause is a concurrent non-isolated flow,
not the scroll. See [[patterns_per_worker_data_isolation]].
