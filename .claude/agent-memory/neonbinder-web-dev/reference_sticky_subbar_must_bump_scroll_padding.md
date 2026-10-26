---
name: sticky-subbar-must-bump-scroll-padding
description: A page bar that sticks under the app header must grow html's scroll-padding-top inline while mounted (globals.css only clears the 80px header, from sm up), or Tab parks fields under it
metadata:
  type: reference
---

The app/demo header is `sm:sticky` (79px) and `app/globals.css` sets `html { scroll-padding-top: 80px }` from `sm` (40rem) only; on a phone nothing sticks and the padding is 0.

A second bar that sticks below it (`sticky top-0 sm:top-[80px]`, e.g. the inventory Checklists "Adding to" bar, NEO-364) is invisible to that padding, so focus-driven scrolling (Tab, `.focus()`) can park a field underneath it (WCAG 2.4.11).

**How to apply:** in the bar's component, `useEffect` + `ResizeObserver` + window `resize`: set `document.documentElement.style.scrollPaddingTop` to `computed top + bar height + a few px`, and restore the previous inline value on unmount (same shape as FinalCollectionPage's `scrollPaddingBottom` for the floating notice). Keep long hint text OUT of the sticky part (render it as a sibling below) so the bar stays ~54px. A sticky element must be a direct child of the tall container it should stick across (a wrapper div bounds it), so return a fragment. Chrome centres a focused element that was under the padding, verified in the Browser pane.

Related: [[gates-in-a-shared-worktree]].
