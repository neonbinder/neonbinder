---
name: axe-combobox-popup-and-listbox-children
description: axe 4.13 exempts a scrollable listbox from scrollable-region-focusable ONLY when a role=combobox's aria-controls names it; a listbox may own only options; an empty listbox is "needs review", not a violation
metadata:
  type: reference
---

Three axe-core 4.13 rules that shaped the NEO-341 Playwright axe-gate fixes in the set builder pickers:

- **scrollable-region-focusable** skips an element when `isComboboxPopup` is true. That means the element has a popup role (listbox, tree, grid, dialog) and either its nearest roled ancestor is a combobox, or some `[role=combobox]` has `aria-controls`/`aria-owns` set to the element's OWN id. Pointing `aria-controls` at a wrapper around the listbox (the old Maestro workaround in EntitySelector) hides that link. The scrollable listbox, whose options are `tabIndex=-1`, then fails the rule. Fix: put the id on the listbox itself, as the APG pattern does. Don't make the listbox `tabIndex=0`: the search box is the column's only Tab stop.
- **aria-required-children**: a `role=listbox` container that also holds the search input, status lines, a Cancel button or a SportSwitch trigger fails. Put the role on an inner div that holds only the `role=option` rows. TeamPicker (NEO-236), PlayerPicker and EntityLinkSearch now all use this shape. `PickerPopover` takes a `role` prop, but no picker should pass `listbox` to it.
- An **empty listbox** is in the rule's `reviewEmpty` list. axe reports it as incomplete, not as a violation. So the inner listbox can stay mounted for the popover's whole life, and "listbox present" still means "popover open".

Related target-size (2.5.8) pattern: a standalone text link or a 10–12px caption button needs a 24px box. Use `inline-block py-0.5` (text-sm) or `py-1` (text-xs). Avoid `inline-flex` on a link whose arrow sits in a span that starts with a space: flex blockifies the span and drops the space. For a list row, pad the row with `py-0.5` and let the button reclaim the padding with `-my-0.5 py-0.5`, so the text stays where it was.
