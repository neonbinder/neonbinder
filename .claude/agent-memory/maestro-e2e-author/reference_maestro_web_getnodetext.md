---
name: maestro-web-getnodetext-form-values
description: How Maestro-web (cli 2.6.0) turns DOM nodes into the `text` its assertions match — inputs/selects/derived spans ALL expose their current value, so form-control VALUES are assertable
metadata:
  type: reference
---

Authoritative source: `~/.maestro/lib/maestro-client.jar!maestro-web.js` `getNodeText` (extract with `unzip -o ...maestro-client.jar maestro-web.js`). This is what the `test:e2e*` npm scripts use (maestro-cli 2.6.0). Per tagName the node's `text` (what `assertVisible`/`scrollUntilVisible`/`tapOn text:` match) is:

- **`<input>` / `<textarea>`** → `value || placeholder || ariaLabel`. So an input's CURRENT VALUE is directly matchable. (Empty input falls through to placeholder, e.g. "—".)
- **`<select>`** → `Array.from(node.selectedOptions).map(o => o.text).join(', ')` — ONLY the SELECTED option(s). Un-selected `<option>` nodes are OMITTED from the hierarchy entirely unless the `<select>` is `:focus-within` (line ~124). So a `<select>`'s selected value is matchable and does NOT false-match its other options.
- **everything else** → **ONLY the node's DIRECT `TEXT_NODE` children, joined** — `[...node.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent…).join('')`. **This is NOT `textContent`.** A `<div>` whose children are all ELEMENTS has text `""`, so no ancestor ever carries its descendants' concatenated text. Consequences, both paid for on NEO-157 (2026-08-13):
  - You **cannot** assert a string composed across sibling elements (`<div>3</div><div>BACK</div>` never yields `"3BACK"` on the parent). A pattern like `.*3BACKSheet 1.*` matches nothing, anywhere.
  - You **can** assert a string composed of several adjacent JSX text expressions on ONE element — `<span>Sheet {n} — {side}</span>` is three text nodes on one span and reads `"Sheet 1 — front"`.
  - A leaf's visible text IS matched even under an aria-label (unlike Chrome's a11y tree / read_page, which show the aria-label name).

Also: `resource-id` = `node.id || node.ariaLabel || node.name || node.title || node.htmlFor || data-testid` (line ~128-130) — so an element's **aria-label is queryable as `id:`**, and a control with an aria-label AND a value is matchable by the COMBINED `{ id: "<aria-label>", text: "<value>" }` selector (both on the same node). This is the robust way to assert a specific form field's value.

Bounds: `getNodeBounds` emits raw `getBoundingClientRect` for EVERY node — the JS itself does no viewport filtering, but the **Kotlin side does**: `ViewHierarchyKt.filterOutOfBounds` prunes the tree before any selector runs (see [[maestro-web-driver-primitives]] §3a). A below-fold element is therefore ABSENT, not merely "not visible" → drive value assertions via `scrollUntilVisible` (which scrolls it in AND asserts) instead.

This CORRECTS a former belief that `<input>`/`<select>` values aren't in Maestro's text hierarchy — they are. Verified empirically 2026-07-12 (new-chain / sport-level-league flows GREEN asserting Reprint/CardType/ParallelName/Manufacturer inputs + Era/League selects). See [[write-once-feature-snapshots-panel-assertability]].
