---
name: card-detail-drawer-inner-scroll
description: scrollUntilVisible cannot reach anything below the fold inside CardDetailPanel — the drawer has its own scroll container and the centre swipe lands on the backdrop; use manual swipes at x=80%
metadata:
  type: feedback
---

**Inside `CardDetailPanel`, `scrollUntilVisible` cannot reach a field below the
fold. Use manual swipes at x=80% instead:**

```yaml
- swipe: { start: "80%, 80%", end: "80%, 20%" }
- swipe: { start: "80%, 80%", end: "80%, 20%" }
- extendedWaitUntil: { visible: { id: "<field aria-label>" }, timeout: 7000 }
```

**Why:** the drawer is right-anchored (`sm:w-[30rem]`, so x>=544 at the 1024px
CI viewport) and its body is its own `overflow-y-auto` container.
`scrollUntilVisible` swipes from the VIEWPORT centre (x=512), which lands on the
modal backdrop — the page behind does not scroll and the drawer never moves, so
the command burns its whole timeout and fails with "No visible element found"
on an element that is genuinely rendered, ~120px below the fold. Two swipes
reach the middle sections (Card variation, Variation of); three reach the last
one (Players) — `player-picker-create-custom-card.yaml` and
`checklist-fetch-unknown-entities-link-existing.yaml` are the precedents.

**How to apply:** R8's `centerElement: true` is not available here, because
`scrollUntilVisible` cannot be used at all — pair the swipes with a hard
`extendedWaitUntil` on the target and say so in a comment so the missing
`centerElement` does not read as an oversight.

Do NOT be reassured by `card-detail-panel.yaml` scrolling to `id: "Toggle RC"`:
the attribute chips are already ON SCREEN when the drawer opens, so that
`scrollUntilVisible` is satisfied without ever scrolling anything. Nothing in
the suite had actually exercised the drawer's inner scroll before NEO-189.

Drawer body order (top to bottom): Card name, Teams, features toggle, Card
title, Card description, Attributes chips, Print run + Autographed, Card
variation, **Variation of** (NEO-189), Players, Inherited from set, Images.
Everything from "Card variation" down needs the swipes.

See also [[local-https-hangs-chrome]].
