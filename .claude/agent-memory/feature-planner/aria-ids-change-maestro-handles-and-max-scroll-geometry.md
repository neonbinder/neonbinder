---
name: aria-ids-change-maestro-handles-and-max-scroll-geometry
description: Two set-builder planning rules — an ARIA IDREF pattern (aria-activedescendant/aria-controls) puts DOM ids on options and listboxes, which rewrites Maestro's resource-id and breaks every flow targeting those nodes by aria-label `id:`; and content added ABOVE bottom-anchored controls does not move them at maximum scroll, so the NEO-260 spacer arithmetic only cares about distance-to-document-bottom.
metadata:
  type: project
---

Two things to settle up front when a plan touches the set-builder cascade:

1. **ARIA ids rewrite Maestro handles.** `resource-id = node.id || node.ariaLabel`.
   A combobox + listbox with `aria-activedescendant` needs real DOM ids on the
   listbox (`aria-controls`) and on options. Any flow that targets those nodes
   by `id: "<aria-label>"` (the pinned "All Brands — every set in …" entry, the
   listbox `id: "Sports"`) silently loses its handle. Plan the flow edits in the
   same PR: switch them to visible `text:` anchored `below:` the search box.
   Inputs keep their aria-label handle only because the `Input` primitive never
   emits an id — keep it that way.
   **Why:** NEO-224 chose activedescendant (focus must stay in the search
   input for "typing filters, Enter selects"); roving focus cannot express
   "focus in the box with the first row highlighted".
   **How to apply:** grep `.maestro/flows` for `id: "` matches on the nodes
   that will gain ids before claiming "no flow changes".

2. **Height above bottom-anchored controls is free at max scroll.** The
   NEO-260 spacer window (control centre must land ~250-460 at maximum scroll)
   is about a control's distance to the DOCUMENT BOTTOM. Adding a row between
   the cascade and the attributes panel shifts things at scroll 0 but not at
   max scroll; flows that reach those controls with centred `scrollUntilVisible`
   are unaffected. Height INSIDE or ABOVE the cascade is the risky kind
   (NEO-47/155/167): first-fold taps on Sports rows move.
   **How to apply:** put new set-builder chrome BELOW the columns row, not in
   the page header; render it at constant height from first paint, never
   conditionally after a tap.
