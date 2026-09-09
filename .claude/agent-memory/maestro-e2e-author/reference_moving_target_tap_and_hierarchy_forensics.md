---
name: moving-target-tap-and-hierarchy-forensics
description: "The MOVING-TARGET tap class — a silently-missed click caused by the target moving between Maestro's hierarchy read and its click, not by occlusion or a dropped tap. How to prove it from the CI debug bundle's screen-hierarchy JSON, and how to reproduce/verify layout geometry in headless Chrome without any app server."
metadata:
  type: reference
---

# The moving-target tap (a THIRD failure class, distinct from the dropped tap)

Not the CDP dropped tap ([[maestro-web-tap-reliability]]) and not occlusion. Here the
click is dispatched correctly at coordinates that were correct **when the hierarchy was
read** and stale **by the time the click lands**. Maestro reads bounds, then clicks
~330ms later; anything that re-lays-out the page in that window moves the target out
from under the captured point. No error, no crash — the handler simply never fires.

## Signature (all three together)

1. The log shows the matcher resolved to the RIGHT node with sane bounds:
   `Tapping on element: UiElement(... text=Add All Remaining as New (328), bounds=[194,521][386,537] ...)`
   → so it is NOT a container-match or a bad selector.
2. `hierarchyBasedTap: Something has changed in the UI … Proceed` arrives **~6s** after
   the click instead of the usual ~1.2s. `retryTapIfNoChange` saw nothing change and
   waited until ambient reactivity (a counter ticking) satisfied it. **That gap is the
   tell.** Compare it against the other taps in the same log — they are all ~1.2s.
3. The follow-up assert times out with the app in a perfectly healthy state, and the
   before/after screenshots are byte-identical.

## Proving it: the CI debug bundle carries a FULL view hierarchy with bounds

`maestro-report/debug/<suite>/<flow name>/screen-hierarchy/step-NNN-*.json` is the
complete tree (text, resource-id, bounds) at the failing step — not just a screenshot.
Dump it and diff the target's bounds against the bounds the log printed at tap time:

```bash
python3 -c "
import json
def walk(n,d=0):
    a=n.get('attributes',{})
    if a.get('text') or a.get('resource-id'):
        print('  '*d, repr(a.get('text',''))[:80],'|',a.get('resource-id',''),'|',a.get('bounds'))
    for c in n.get('children') or []: walk(c,d+1)
walk(json.load(open('…/screen-hierarchy/step-087-assertCondition-X.json')))"
```

NEO-212 seed failure (run 33817648830): bulk link `[194,521][386,537]` at tap time vs
`[194,532][386,548]` at the assert. 11px down, on a 16px-tall `text-xs` link → the
click at its captured centre (290,529) landed 3px above it. Diagnosed from artifacts
alone, no repro needed.

**Bonus read from the same dump:** elements whose bounds sit OUTSIDE their scroll
container's box are CSS-clipped and unreachable, even though they are in the hierarchy.
In that dump the row's own "Link to Existing…" `[194,524][297,540]` overlapped the
footer's `[194,532][386,548]` — impossible in flow layout, and the giveaway that 55px
of the body had overflowed its `max-h` into an inner scroll region Maestro cannot drive.

## The commonest CAUSE: an elastic-height centred modal

An overlay that centres its dialog (`flex items-center`) turns any body-height change
into a footer move of **half the delta**. A body with `min-h-X max-h-Y` has a Y−X band
it can travel through as async content lands (a Wikidata description, a resolved-teams
line, a near-match panel — each on its own query, arriving over the first few seconds).
Half of that band is the worst-case shift, and a `text-xs` control is only 16px tall,
so even a ~13px "bounded" residual is a coin flip.

**A reserved min-height only BOUNDS the shift; it does not remove it.** The fix that
removes it is a dialog with a DEFINITE height (`h-[min(40rem,100%)]` — 100% resolves
against the overlay's content box, so the overlay's `p-4` is respected automatically)
plus `flex-1 min-h-0 overflow-y-auto` on the body. Then the footer's y is invariant.
NEO-110 shipped the min-height bound twice (108px → ~28px → ~13px) before the 13px
came due; do not re-litigate it with a bigger number.

## Verifying layout geometry with NO app server (headless-shell + --dump-dom)

`~/.cache/puppeteer/chrome-headless-shell/*/chrome-headless-shell-mac-arm64/chrome-headless-shell`
exists on this machine even though `puppeteer` is not installed in any workspace. There
is no `ws`/puppeteer package to script CDP with — so let the PAGE do the measuring and
print the answer into the DOM, then read it back:

```bash
chrome-headless-shell --headless --disable-gpu --window-size=1024,629 \
  --virtual-time-budget=4000 --dump-dom "file://$SP/geometry.html"
```

Build the page against the app's REAL compiled CSS (`cp dist/assets/index-*.css`
next to it after `npm run build`) so the Tailwind classes resolve exactly as shipped.
Inside, render the old and new class strings, mutate a spacer to simulate the async
growth, and report `getBoundingClientRect()` plus — the money shot —
`document.elementFromPoint(x,y)` at the pre-growth click centre. On NEO-212 that
returned `<div id="footer">` for the old markup and `<button id="bulk">` for the new:
a real Chrome hit-test proving both the miss and the fix, in seconds, with no Vite,
no Convex and no Maestro run. Tune the spacer until the harness reproduces the bounds
the CI hierarchy recorded — when it does, you know the model is right.

Related: [[maestro-web-driver-primitives]] (filterOutOfBounds), [[maestro-web-tap-reliability]].
