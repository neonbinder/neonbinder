---
name: convex-doc-size-budget-counts-framing
description: A per-document byte budget over UTF-8 key+value bytes undercounts Convex's getDocumentSize by ~3 bytes per field and ~10 per nested object; many tiny fields can blow the bound
metadata:
  type: reference
---

`getDocumentSize` (from `convex/values`) charges roughly key bytes + value
bytes + 3 per string field, and a few more for each nested object frame
(measured: `{}` 63, `{k:"a"}` 68, `{k:{}}` 67). A budget that counts only
UTF-8 key and value bytes looks safe for fat values but not for thousands of
one-character fields: a 2000-line sale with a 100 KB "key+value" budget
measured 1,001,883 bytes, over a 1,000,000 target.

**How to apply:** when capping an array of optional sub-objects to keep a
document under a size, count a per-field overhead (3) and a per-object
overhead (10) in the cost function, and prove it with a `getDocumentSize`
test over BOTH worst shapes: values at their bounds in 3-byte characters,
and the most lines of one-character values. Convex `VObject` has
`.omit(...)`, `.pick(...)`, `.partial()` and `.extend({...})`, so a wire
variant of a stored shape can reuse the schema validator rather than copy it.
See [[new-table-naming-a-card-three-places]] for the other gate a new nested
id field trips.
