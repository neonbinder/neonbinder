---
name: narrowing-convex-validator-is-a-runtime-break
description: Narrowing a Convex `v.object` args validator (e.g. metadata to one key) passes tsc but fails at runtime with "Unexpected field" wherever the FE forwards a stored doc sub-object whole; grep the FE forwards before narrowing
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
