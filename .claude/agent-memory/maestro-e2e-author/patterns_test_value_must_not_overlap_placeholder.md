---
name: test-value-must-not-overlap-placeholder
description: An empty <input> reads back its PLACEHOLDER as its text in maestro-web, so a typed test value that is a substring of the placeholder (placeholder "e.g. DK-", value "DK-") makes every read-back and every `.*value.*` negative ambiguous — pick a value sharing no substring with the placeholder
metadata:
  type: feedback
---

When a flow writes a value into a text field and later proves it persisted
(or was cleared) by reading the field back, choose a value that shares NO
substring with the field's placeholder.

**Why:** maestro-web's `getNodeText` for an `<input>` is
`value || placeholder || ariaLabel` (see [[maestro-web-getnodetext-form-values]]),
so an EMPTY field's text IS its placeholder. NEO-291's Card prefix row has
placeholder `e.g. DK-`; the plan's test value was `DK-`. A stored `DK-` and an
empty field would then differ only by the matcher's full-match semantics, and
the planned `assertNotVisible text: ".*DK-.*"` after the clear would have
FAILED on the placeholder of a correctly-cleared field. Written with `CPX-`
instead, `text: "CPX-"` (persisted) and `text: "e.g. DK-"` (cleared) are
decisive under either reading.

**How to apply:** before writing a value into any text control, read its
placeholder in the component; make the sentinel and the value under test
disjoint from it. Assert the cleared state positively as `{id: <aria-label>,
text: "<placeholder>"}` and only then the negative on the old value.
