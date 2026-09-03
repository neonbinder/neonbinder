---
name: native-select-option-taps
description: "How maestro-web drives a native <select>: options only appear in the hierarchy when the select is focused, and the synthetic-option tap resolves by INDEX against the FIRST <select> in the document — so two selects on screen make the tap land in the wrong one"
metadata:
  type: reference
---

Verified by reading `maestro-web.js` out of `~/.maestro/lib/maestro-client.jar`
(`unzip -o ~/.maestro/lib/maestro-client.jar maestro-web.js`), CLI 2.6.0.

## The mechanism

* `getNodeText(<select>)` = the SELECTED option's text only. So a closed picker
  is matchable by what it currently reads (`tapOn: "All sports"`), and that is
  also the honest read-back assertion after changing it.
* `<option>` nodes are dropped from the hierarchy unless
  `option.parentElement.matches(':focus-within')`. So the sequence is always
  **tap the select first (focuses it), then tap the option text.**
* `resource-id` precedence is `node.id || node.ariaLabel || node.name ||
  node.title || node.htmlFor || data-testid`. A `<select id="x">` with
  `<label for="x">` therefore produces TWO nodes carrying `resource-id: "x"` —
  the label and the select — so `id:` alone is ambiguous there. Match the
  select by its selected-option text instead.

## The trap: synthetic bounds collide across selects

Options have no layout box, so maestro invents bounds at
`x = 100000, y = 100000 + (indexInParent * 20)` — **derived only from the
option's index within its own parent.** `maestro.tapOnSyntheticElement(x, y)`
then walks `document.querySelectorAll('option')` in DOCUMENT ORDER and acts on
the FIRST option whose synthetic bounds contain the point.

Consequence: with two `<select>`s on the page, tapping option *n* of the second
one sets option *n* of the **first** one instead — silently, with no error. The
hierarchy shows only the focused select's options, so the flow looks correct and
the wrong control changes.

**Rule: only drive a native select while it is the ONLY `<select>` in the DOM.**
Re-order the flow if necessary — e.g. on `/admin/players` the add form's Sport
picker is unreachable this way (the list's Sport filter is earlier in the DOM
and has an identical option order), so the flow sets the LIST filter while the
form is closed and lets the form inherit it as its default.

## Related visible-text gotcha

Before tapping an option by its text, make sure that text is not also on screen
elsewhere (list rows that print a sport/category name are the usual culprit).
Filtering the list to a name nothing matches first is a cheap way to guarantee
the option text is unique.

See also [[virtualized-list-phantom-rows]] for the other "the node maestro
matched is not the node you meant" family.
