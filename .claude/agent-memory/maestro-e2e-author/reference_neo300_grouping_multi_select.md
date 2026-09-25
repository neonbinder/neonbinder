---
name: neo300-grouping-multi-select
description: ParallelGroupingModal multi-select (NEO-300) handles — `Select <row>` tick, `N selected` pill, N-row box hints; a DOM id added for arrow-key focus would clobber the tick's handle
metadata:
  type: reference
---

Group Parallels rows each carry a tick box, a `<button role="checkbox">` with
the accessible name `Select <row value>` and NO text (it holds only an svg). So
`id: "Select <row>"` is the only handle a flow has. maestro-web cannot hold
Cmd/Ctrl or Shift during a tap, so the modifier shortcuts are unit-test only.

- A tick TOGGLES the row (it adds to the selection and never replaces it) and
  stops propagation, so it never drops rows into the box behind it.
- The footer shows `N selected` as one text node, next to a `Clear` button whose
  accessible name is `Clear selection`. The footer is pinned, so assert through it.
- With 2 or more selected, boxes read `Click here to make the N selected rows
  parallels`, the top-level zone reads `Click here to place the N selected rows
  at the top level`, and a selected row's own box reads `This row is selected…`.
  The one-row wording is unchanged.
- A tap on another box's TITLE moves the whole selection and spends it. Before
  it: `No changes yet`. After it: `N promotions, 0 demotions`.
- A row that holds parallels has a disabled tick.

**Trap caught while the feature was being built:** the first commit put
`id="parallel-grouping-tick-<rowId>"` on the tick (so the arrow keys could find
their neighbour) and `id="parallel-grouping-clear-selection"` on Clear. Because
`resource-id = node.id || ariaLabel`, those DOM ids hid both accessible names.
The fix swapped the ids for a `data-grouping-control` attribute. Whenever a
component gains keyboard focus management, grep it for new `id=` on controls a
flow targets by aria-label. See [[touch-swipe-scrolls-a-dialog-body]].

Worked example: `parallel-grouping-multi-select-moves-together.yaml`. It uses
three inserts that do not prefix-match each other, so detection suggests
nothing. At scrollTop 0 every tick and the first box's title sit inside the
body, so no swipe is needed. Measured locally: the Bolt and Comet ticks at
y=251 and y=295, the first box's title at y=376.
