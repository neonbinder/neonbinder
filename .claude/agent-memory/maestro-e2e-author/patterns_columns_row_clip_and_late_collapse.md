---
name: columns-row-clip-and-late-collapse
description: "Two set-builder columns-row geometry facts that kill steps — a collapsed card hangs off the LEFT edge at negative x once five columns are open (no vertical scroll recovers it; visibilityPercentage: 10 normalizes to 0.0), and the cascade collapse of the just-picked column lands ~5s LATE, sliding every column to its right by exactly 80px under a pending tap."
metadata:
  type: pattern
---

# The columns row is a horizontal scroller, and it moves twice

`SetSelector`'s selector columns live in one `overflow-x-auto` row. maestro-web
drives only the WINDOW, never an inner scroller
([[maestro-web-cannot-scroll-after-base-picker]]), and prunes the hierarchy by
VIEWPORT ([[inner-scroller-clip-is-invisible-to-maestro]]). Two consequences,
both measured in CI 35731602457.

## 1. A collapsed card at NEGATIVE x — assert it, never scroll to it at 100%

With five columns open (Sport / Year / Manufacturers / Sets / Variant Types)
the row is scrolled right and the left-hand collapsed cards hang off the left
edge. `move-set-to-another-brand` measured
`Bounds(x=-122, y=301, width=265)` for `Manufacturers: Panini — change`:
**53.96% visible, identical on every retry for the full 7s**, while the node
carried the right aria-label and the breadcrumb read the right chain. The
element is fine; `scrollUntilVisible`'s DEFAULT `visibilityPercentage: 100` is
unsatisfiable, and `direction: UP` cannot recover a HORIZONTAL clip.

Fix: `visibilityPercentage: 10` (or a plain `assertVisible` after anchoring on
a fully-visible sibling card). The claim survives — a card that had really
gone would be pruned from the hierarchy entirely and still fail. Useful
detail: cli 2.6.0 computes the threshold with **integer division**, so the log
prints `visibilityPercentageNormalized: 0.0` for `visibilityPercentage: 10` —
anything under 100 is effectively "present in the hierarchy".

Card geometry (fixed, data-independent): collapsed card 260px, expanded column
340px, gap 16px — so a card's x never depends on how long the brand is called.

## 2. The cascade collapse is LATE: +80px to everything on its right

Picking a row collapses its column into a card, but the collapse waits on the
NEXT column's query. `card-features-editor-toggle` picked its set at
13:39:40.9; at 13:39:46.2 `Add custom Variant Types` still read
`[679,306][773,338]` (Sets column still EXPANDED); Maestro clicked its centre
(726,322); 1.16s later the Sets column collapsed and the button was at
`[599,312][693,344]` — **exactly 340 − 260 = 80px left**, with the click now
33px outside it. The dialog never opened; the create-gate histogram proved the
backend healthy (0.97–0.98s on the same runner either side of it), so this is a
moving-target tap ([[moving-target-tap-and-hierarchy-forensics]]), not a
stalled write.

`waitToSettleTimeoutMs` on the tap does NOT defend against it — the log says
"Tap aimed via settled hierarchy" and still uses the pre-collapse bounds,
because the collapse had not happened yet.

The gate that does work is the collapsed card itself, which is the product's
own signal that the cascade has settled. Before any scroll-then-tap at level
N+1, wait on level N's card:

```yaml
- extendedWaitUntil:
    visible:
      id: "Sets: ${SET_NAME} — change"
    timeout: 7000
```
