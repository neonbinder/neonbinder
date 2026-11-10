---
name: dndkit-droppables-in-their-own-scroll-pane
description: dnd-kit 6 handles droppables inside a second scroll pane (two-pane drag layouts) without measuring tweaks; what autoscroll actually scrolls, and the one grid rule the panes need
metadata:
  type: reference
---

When a drag source and its drop targets live in two sibling scroll panes
(ParallelGroupingModal since NEO-472), dnd-kit 6.3 needs no `measuring`
config:

- Droppable rects are measured once at drag start, but each is a dnd-kit
  `Rect` that reads its OWN scrollable ancestors live (getter adds the scroll
  delta), so a pane that scrolls mid-drag still collides correctly.
- Autoscroll scrolls the scrollable ancestors of the droppable under the
  pointer (`overNode ?? activeNode`). Over a gap between boxes it falls back
  to the dragged row's pane, so keep drop boxes tight to the pane.
- `overflow: hidden` is not a scroll ancestor to dnd-kit (it checks
  auto/scroll/overlay), so a body that holds still from `md` up drops out.
- A two-pane grid inside a flex column needs `grid-rows-1`
  (minmax(0,1fr)) plus `min-h-0` on the panes, or the auto row grows to the
  content and neither pane scrolls.

Related: [[dndkit-pointerwithin-kills-keyboard-drops]], [[dndkit-row-control-is-a-handle-sibling]].
