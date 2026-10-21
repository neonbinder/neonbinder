---
name: wrapping-label-select-name-includes-option
description: A <select> inside a wrapping <label> gets an accessible name that includes its selected option's text ("Binder All"), so getByLabel("Binder", exact) misses it; give the select its own aria-label and aria-hide the visible word
metadata:
  type: reference
---

Seen on NEO-350 (the collection page's "Binder: [All ▾]" picker). With
`<label><span>Binder</span><select>…</select></label>` the computed name is the
label's text content, which includes the select's current option, so the name
changes with the selection and an exact `getByLabel("Binder")` / role+name
locator times out.

**How to apply:** for an inline-labelled select, put `aria-label="<word>"` on the
`<select>` and `aria-hidden="true"` on the visible word (no DOM id needed, see
[[interactive-controls-carry-no-dom-id]]). Text inputs in a wrapping label are not
affected.

Related harness quirk: while a modal Overlay makes the page `inert`, Playwright's
`getByLabel("Set")` still matches background regions/buttons whose aria-label
merely contains "Set"; scope with `getByRole("textbox", { name, exact: true })`.
See [[convex-free-page-harness]].
