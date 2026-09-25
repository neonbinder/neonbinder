---
name: maestro-web-text-is-direct-text-nodes-only
description: maestro-web's hierarchy `text` for an element is ONLY its direct child text nodes (not descendants), so a row button can carry a muted description line in a sibling element without changing what `text: "Name"` matches — the name span is its own node. Verified by extracting maestro-web.js from ~/.maestro/lib/maestro-client.jar (2.8.0).
metadata:
  type: reference
---

`getNodeText(node)` in the injected `maestro-web.js` (inside
`~/.maestro/lib/maestro-client.jar`, extract with `unzip -o maestro-client.jar
maestro-web.js`) is, for anything but input/textarea/select:

```js
[...node.childNodes].filter(n => n.nodeType === Node.TEXT_NODE)
  .map(n => n.textContent.replace('\n','').replace('\t','')).join('')
```

So a `<button>` containing `<span>Topps Chrome</span><div>Topps</div>` yields
THREE hierarchy nodes: the button with text `""`, the span with `Topps Chrome`,
the div with `Topps`. A flow's `text: "Topps Chrome"` (a FULL-string match) still
finds exactly the span; the description never concatenates into it.

**How to apply:**
- Adding a second line (a brand suffix, "Every set in 1995") under a row's name
  is safe for every flow that taps or asserts the name by `text:` — keep the name
  alone in its own element.
- `resource-id` is `node.id || node.ariaLabel` on the element that carries it;
  giving a row button an `aria-label` changes its `id:` handle but not the
  `text:` of the span inside it.
- Inputs are the exception: their `text` is `value || placeholder || ariaLabel`.

**Type-ahead hazard (NEO-307):** because an input's `text` is its value, a flow
that types a combobox's full option label and then does `tapOn: "<label>"` has
TWO matches — the input and the `<li role="option">`. Tell flow authors to type
a distinguishing substring (e.g. the per-attempt token alone) so only the
option carries the whole label. A resting combobox showing its answer ("MLB",
"Giants") also satisfies `assertVisible: "<label>"` through its value.
