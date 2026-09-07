---
name: input-primitive-has-no-resource-id
description: "components/primitives/Input deliberately emits no id and no aria-label, so `id: \"<label text>\"` NEVER resolves on it. Tap it by its label TEXT; assert its contents by its VALUE (maestro reads an <input> as node.value)."
metadata:
  type: reference
---

`maestro-web.js` builds `resource-id` from
`node.id || node.ariaLabel || node.name || node.title || node.htmlFor ||
data-testid` — and `node.ariaLabel` is the **attribute reflection**, not the
computed accessible name. `components/primitives/Input` passes `label` through a
WRAPPING `<label><span>{label}</span><input/></label>` and its header says it
"NEVER emits an `id` of its own" (an auto id would clobber the resource-id every
`tapOn id:` selector in the suite depends on).

So for a field rendered as `<Input label="New player name" …/>`:

* `id: "New player name"` → **no such node.** Silent, slow failure.
* `tapOn: "New player name"` → matches the `<span>` inside the `<label>`;
  clicking a label descendant focuses the control. This is what every green
  admin flow already does (`Filter players`, `Filter teams`, `Franchise name`).
* to read the field back, match its **value**: `getNodeText(<input>)` is
  `node.value || node.placeholder || node.ariaLabel`, so
  `assertVisible: "Samename<token>"` asserts the field holds that string.
  Anchor with `below:` when the value could also be a list row.

`id:` DOES work where the caller passes an explicit `aria-label` — e.g.
`NewTeamForm`'s `aria-label="New team name"` / `"New team location (optional)"`,
which is why `id: "New team name"` is correct there and wrong on an admin form.
Check the component before reaching for `id:`.

Escape regex metacharacters in label text: `tapOn: "Birth year \\(optional\\)"`.
