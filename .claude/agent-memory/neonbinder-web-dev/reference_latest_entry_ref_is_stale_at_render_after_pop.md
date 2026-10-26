---
name: latest-entry-ref-is-stale-at-render-after-pop
description: A "newest history entry" ref synced in a layout effect is one entry behind during the render a browser Back (POP) triggers; build Link href/state from useLocation() and rebuild a push in onClick from the ref; MemoryRouter clamps go(-n) so overshoot tests need an entry ahead
metadata:
  type: reference
---

The collection page keeps a ref of the newest history entry it asked for
(`LatestEntry` in `app/collection/final/mode.tsx`), synced from `useLocation()`
in a `useLayoutEffect`. After a browser Back (POP) the router renders the
entry it went back to BEFORE that effect runs. Any `<Link state={…}>` computed
at render from the ref therefore builds on the entry the visitor just left.
Links do not re-render when the ref catches up. NEO-364: the demo's long-box
door pushed `demoDepth` 3 instead of 2 after one Back, so "Back to the tour"
(`navigate(-(depth+1))`) overshot history, and the browser silently ignored it.

**How to apply:**
- In render, build hrefs and state from `useLocation()`.
- In a plain-click `onClick`, `preventDefault()` and rebuild the push from the
  ref. Event handlers run after layout effects, so the ref is current there,
  and it also covers a second click while the first push's transition is
  still pending.
- Mirror Link's own rule that a link to the URL already showing REPLACES the
  entry, and keep that entry's state on the replace, never depth+1.
- New history state carries only the fields that belong to every entry
  (`demoFrom`, `demoDepth`). Never spread the current entry's state: a
  per-entry flag like the drawer's `drawer: true` leaks onto later views.

**Testing it:** MemoryRouter clamps `go(-n)` at index 0, so if the tour entry
is the first entry, an overshoot still "lands on the tour" and the test
passes against the bug. Start with an extra entry ahead
(`initialEntries={["/came-from", "/binder-tracking"]} initialIndex={1}`) so
an overshoot shows up as `/came-from`.

Related: [[router-navigation-is-a-transition]].
