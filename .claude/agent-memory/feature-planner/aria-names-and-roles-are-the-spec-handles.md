---
name: aria-names-and-roles-are-the-spec-handles
description: Planning rule for any change that renames, relabels or re-roles a control — the Playwright specs locate only by role + accessible name, label, visible text, placeholder, title or alt, so the plan must name the specs that move with the copy; and an ARIA IDREF pattern (aria-activedescendant/aria-controls) puts DOM ids on options and listboxes but leaves their accessible names intact
metadata:
  type: project
---

Two things to settle up front when a plan touches the set-builder cascade or any
screen specs drive:

1. **Names and roles are the handles.** Specs find controls by `getByRole(role, { name })`,
   `getByLabel`, `getByText`, `getByPlaceholder`, `getByTitle`, `getByAltText`; there is
   no id/test-id escape hatch. A rename, an `aria-label` change, a role change (a
   `radiogroup` becoming a `combobox`) or new copy that makes an existing substring
   match ambiguous breaks specs. Plan the spec edits in the SAME PR and say which specs.
   A combobox + listbox with `aria-activedescendant` needs real DOM ids on the listbox
   (`aria-controls`) and on options, but each keeps its accessible name, so the spec
   handle survives (NEO-224 chose activedescendant because focus must stay in the search
   input for "typing filters, Enter selects").
   **How to apply:** grep `apps/web/playwright/{tests,support}` for the old names before
   claiming "no spec changes". If a control has NO perceivable handle, the plan must
   add one in product code (a distinct accessible name), never a test id.

2. **Layout: put new set-builder chrome BELOW the columns row.** Height INSIDE or ABOVE
   the cascade moves first-fold controls (NEO-47/155/167); render new chrome at constant
   height from first paint, never conditionally after a click, so the specs' scrolling
   and reachability assertions (`toBeInViewport`) stay stable.
