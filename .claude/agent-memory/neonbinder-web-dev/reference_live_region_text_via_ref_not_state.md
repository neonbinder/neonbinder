---
name: live-region-text-via-ref-not-state
description: react-hooks/set-state-in-effect refuses "mount empty, then setState the message" for a live region; write textContent through a ref in the effect instead; repeat words via id-keyed clear + rAF
metadata:
  type: reference
---

A polite live region must exist before its text (inserted together, it is announced unreliably), so the natural shape is "render empty, copy the message in from an effect". `setState` inside that effect is a lint error in apps/web (`react-hooks/set-state-in-effect`).

Render the region with NO React children and write `regionRef.current.textContent` in the effect: the DOM is the external system, React never touches those children, and the text lands one commit after the region. Precedent: `NameFragmentLiveRegion` in components/SetSelector/NameFragmentPanel.tsx (NEO-463).

A child's effect runs before its parent's, so a child region can read `document.activeElement` before a parent effect moves focus — useful for "stay quiet when focus is about to move to the panel that says the same thing".

**Same words twice (NEO-529).** A live region speaks only on a text change, so a repeated message ("Nothing to undo." twice) is silent. Key the effect on a per-message id: clear `textContent`, then set it in a `requestAnimationFrame` (cancel it in cleanup); read the words via `useEffectEvent` so deps stay `[id]`; a `useRef(id)` seed keeps the message already up at mount quiet (StrictMode-safe). Then the visible copy must NOT be a live region too. Precedent: `useLiveWords` in app/collection/prototypes/p1/notice.tsx. Test announcements with a MutationObserver collecting non-empty `addedNodes` text (a clear adds none), plus `observer.takeRecords()` before asserting; red-prove the "same notice re-rendered" case with an effect that has no deps.

**Several lines, one message stream.** When the same notice can be drawn by different regions over time (toast, drawer, desk), share a "spoken ids" record through context: claim an id when its frame is scheduled, give it back in the unmounting region's layout-effect cleanup if the frame never ran (deletion cleanups run before the next region's layout effects in the same commit), and let a region drawn over an already-spoken notice set its text in a layout effect (drawn-with-text is not announced, and Playwright's `getByRole("status").filter({hasText})` still finds it). Never cancel a frame in a plain unmount cleanup without resetting the "looked at" ref: StrictMode's rehearsal unmount would swallow the words.

Related: [[ref-cleanup-sees-focus-before-removal]].
