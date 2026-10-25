---
name: schema-pins-text-scan-vs-export-walk
description: The two schema pins that police id-holding tables see different things — the subtree-wipe graph pin scans table-block TEXT, the reference-seed dependant pin walks schema.export(); ids inside an exported validator const are seen by one and not the other
metadata:
  type: reference
---

Two tests fail when a new table holds an id into a catalog table, and they
detect it differently:

- `wipeVariantTypeSubtree.test.ts` ("the reference graph covers every table")
  strips comments from schema.ts and looks for the literal `v.id("<wiped>")`
  inside each `name: defineTable(` block (plus `selectorOptionFields`). An id
  that lives in an exported validator const ABOVE `defineSchema` (e.g. a rule
  or label validator reused by args/returns) is invisible to it. Adding such a
  table to `SUBTREE_REFERENCE_GRAPH` anyway makes the test fail (graph has a key
  the scan did not find).
- `scripts/reference-seed/cli.test.mjs` walks `JSON.parse(schema.export())`
  for every `{type:"id", tableName:"selectorOptions"}` node, so it DOES see ids
  nested in a shared validator, and the table must join
  `SELECTOR_DEPENDANT_TABLES` (or the undrained list).

**How to apply:** when a design puts NB ids inside an exported validator
(NEO-359's smart-binder rule on `collectionContainers`), list both
consequences in the plan: the reference-seed list entry is required; the wipe
graph will not ask, so state in the plan why the ids are safe from a subtree
wipe (e.g. sport/brand/set level, above the subtree) and that readers tolerate
a dangling id. Inline `v.id(...)` fields in a table block hit both pins.
Related: [[transient-side-table-checklist]].
