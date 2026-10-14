---
name: test-value-must-not-overlap-placeholder
description: A typed test value that is a substring of the field's placeholder (placeholder "e.g. DK-", value "DK-") makes name/text-based read-backs and "value is gone" checks ambiguous — pick a value sharing no substring with the placeholder, and read values with toHaveValue
metadata:
  type: feedback
---

When a spec writes a value into a text field and later proves it persisted (or
was cleared), choose a value that shares NO substring with the field's
placeholder.

**Why:** the old driver read an EMPTY input's text as its placeholder, and
NEO-291's Card prefix row had placeholder `e.g. DK-` while the plan's test value
was `DK-`, so a "value is gone" negative would have FAILED on the placeholder of
a correctly-cleared field. Playwright separates the two (`toHaveValue` reads the
value, `getByPlaceholder` finds by placeholder), but a text-based check
(`getByText`, a regex over the container) can still match the placeholder, and a
value that overlaps it muddies both the failure message and any text assertion
nearby. Written with `CPX-` instead, the persisted and cleared states are
decisive under either reading.

**How to apply:** before writing a value into any text control, read its
placeholder in the component; make the sentinel and the value under test disjoint
from it. Assert state with `toHaveValue("CPX-")` / `toHaveValue("")` on the
labelled field, never with a text match on the container.
