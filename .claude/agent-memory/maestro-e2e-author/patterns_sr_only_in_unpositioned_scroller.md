---
name: sr-only-in-unpositioned-scroller
description: An sr-only span inside a scroller with no positioned ancestor does NOT scroll with its row — it stays at its scrollTop-0 spot, often past the viewport, so Maestro prunes it; read the offset off a Keep-all-style sr-only node, use a visible handle instead
metadata:
  type: reference
---

`sr-only` is `position:absolute` with auto offsets, so it sits at its STATIC
position computed against its containing block. When the nearest positioned
ancestor is OUTSIDE the scroller (a `fixed inset-0` dialog overlay whose
`overflow-y-auto` body has no `relative`), the span does not move when the
body scrolls: it stays where its row was at scrollTop 0. maestro-web lists
sr-only spans as 1×1 nodes, but Kotlin's viewport prune drops one that is
below 629px, so a selector keyed on it (`containsChild: {text: ".*matches the
Base"}`) fails with the row plainly on screen.

**Why:** NEO-325 CI run, Reconcile Parallels: row at y=444, its status span
~217px lower (the body's scrollTop), absent from the dump; the flow waited the
whole 120s with the verdict visible.

**How to apply:** before keying on any sr-only text inside a dialog body,
check the dump for a known sr-only node vs its parent (a Keep all description
at y=353 under a header at y=136 = a 217px scroll) — any offset means the
spans are pinned. Use a visible handle instead (a sleeve's `title` tooltip,
a reason line, a row's accessible name). In flex rows the pinned span's x is
the container's content-box start, not beside the text. The product fix,
if one is wanted, is `relative` on the scroller; it is not a reason to
change product code for Maestro alone. Related: [[neo325-base-check-selectors]],
[[inner-scroller-clip-is-invisible-to-maestro]].
