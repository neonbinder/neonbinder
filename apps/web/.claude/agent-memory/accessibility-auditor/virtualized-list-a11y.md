---
name: virtualized-list-a11y
description: how to convey parent/child or grouping relationships accessibly in react-virtuoso lists here, without ARIA tree/aria-owns
metadata:
  type: project
---

`components/SetSelector/CardChecklist.tsx` renders a react-virtuoso list from
a single flattened array (`displayRows`), where a "parent" row is optionally
followed by its "children" (expanded via a disclosure button). This is the
general shape for any windowed/virtualized nested-list feature in this app —
recorded here from the NEO-189 card-variations audit.

**Verdict: don't reach for `role="tree"`/`role="group"`/`aria-owns` for this
shape.** Reasoning:

- Virtuoso only mounts rows near the viewport. `aria-owns`/`aria-controls`
  referencing an id that may currently be unmounted is a known-fragile
  pattern — the AT relationship silently breaks for any row scrolled out of
  view, which for a virtualized list is most of them.
- A real ARIA tree widget (`role=treeitem`, `aria-level`, `aria-posinset`,
  roving tabindex, arrow-key navigation as the primary nav model) is a much
  bigger redesign than the feature warrants, and would conflict with this
  codebase's existing per-row multi-button model (Edit / Delete / disclosure
  are all independently tab-reachable today — a tree widget wants one tab stop
  per row with arrow keys moving between items).
- The existing pattern — a disclosure button with `aria-expanded`, whose
  controlled content renders immediately after it in DOM/reading order — *is*
  the correct, lighter-weight WAI-ARIA pattern (Disclosure/Show-Hide) for
  this, and it's virtualization-safe because it doesn't depend on any
  cross-element ARIA reference; adjacency in the flattened array is the
  relationship.

**What was actually missing, and the fix applied:** the parent/child
relationship was conveyed *only* visually (indentation + a left border color).
Neither a screen reader's linear read-through nor (especially) a keyboard user
tabbing straight to a variation row's Edit/Delete button got any indication of
which parent it belonged to. Fix: thread the parent's identifying info
(`parentCardNumber`) down through the flattening step in `CardChecklist.tsx`
(look it up from the *unfiltered* card list, not just the currently-visible
`sortedCards`, so an orphaned child whose parent got filtered out still gets a
correct label) and fold it into the child row's own visible/accessible text
(`CardChecklistItem.tsx`'s subtitle line: "Variation of #11"). This survives
virtualization and Tab-only navigation because it's baked into the row's own
content, not a reference to another row.

**Left alone, and why:** the more direct fix — embedding parent context into
the Edit/Delete buttons' own `aria-label`s — was considered but skipped
because those exact aria-label strings are targeted by
`.maestro/flows/set-selector/*.yaml`. See [[maestro-aria-label-coupling]]. If a
future change wants to go further than the subtitle-line text, verify Maestro
selector impact first.

Also note: Virtuoso's default DOM has no `role="list"`/`role="listitem"`
semantics (plain `div`s). Pre-existing, spans the whole list, not something
introduced by any one feature — flag as a possible future enhancement (Virtuoso
supports a `components.List`/`components.Item` override for this) rather than
fixing inline during a feature-scoped audit.
