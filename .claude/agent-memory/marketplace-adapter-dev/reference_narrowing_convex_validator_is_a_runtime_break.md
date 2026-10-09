---
name: narrowing-convex-validator-is-a-runtime-break
description: Narrowing a Convex `v.object` validator, or WIDENING a stored sub-object, passes tsc but fails at runtime with "Unexpected field" wherever a stored sub-object is forwarded whole (FE args, or a query/returns that echoes doc fields)
metadata:
  type: reference
---

Convex `v.object` args validators refuse extra fields at runtime
("Validator error: Unexpected field `x` in object"). TypeScript does NOT
catch a caller passing a wider object through a variable (structural
typing allows extra props off a non-literal), so `npm run typecheck` and
the root tsc stay green while every call fails in the browser.

The house shape that trips it: a modal seeds its rows from stored docs
(`metadata: r.metadata`, `platformData: ...`) and forwards the same object
on commit. Narrowing the mutation's validator without projecting the FE
forward (`{ cardNumberPrefix: r.metadata?.cardNumberPrefix }`) breaks the
whole flow. Also check convex-test files: they send literals the old
validator accepted and go red for the right reason.

**How to apply:** before narrowing any args validator in
`selectorOptions.ts` / `setReconciliation.ts`, grep the FE for every
forward of that arg and name each site in the report so the FE builder
projects it; a red `writeOnceFeatureSnapshots`-style test on the same
field is expected, not a regression.

**The reverse direction bites too.** Adding an optional field to a stored
array element (schema) breaks every `returns` validator that forwards that
array whole with the OLD element validator (e.g. an internal read returning
`doc.entries` under a slimmer `entryValidator`), and every args validator a
caller feeds those elements back into. tsc stays green (`doc.entries` is
assignable). Project at the read (`entries.map(bare)`) and pin it with a
test that stores the new field and then runs the path that reads it back.
