---
name: live-region-text-via-ref-not-state
description: react-hooks/set-state-in-effect refuses "mount empty, then setState the message" for a live region; write textContent through a ref in the effect instead
metadata:
  type: reference
---

A polite live region must exist before its text (inserted together, it is announced unreliably), so the natural shape is "render empty, copy the message in from an effect". `setState` inside that effect is a lint error in apps/web (`react-hooks/set-state-in-effect`).

Render the region with NO React children and write `regionRef.current.textContent` in the effect: the DOM is the external system, React never touches those children, and the text lands one commit after the region. Precedent: `NameFragmentLiveRegion` in components/SetSelector/NameFragmentPanel.tsx (NEO-463).

A child's effect runs before its parent's, so a child region can read `document.activeElement` before a parent effect moves focus — useful for "stay quiet when focus is about to move to the panel that says the same thing".

Related: [[ref-cleanup-sees-focus-before-removal]].
