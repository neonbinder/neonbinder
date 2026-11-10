---
name: convex-test-run-turns-undefined-into-null
description: convex-test's t.run answers an undefined return as null, so `(await ctx.db.get(id))?.field` on an absent optional field reads null, never undefined
metadata:
  type: reference
---

`t.run(async (ctx) => (await ctx.db.get(id))?.someOptionalField)` comes back
as `null` when the field is absent: the value crosses a Convex boundary and
`undefined` is not a Convex value. `expect(...).toBeUndefined()` then fails
with "expected null to be undefined".

**How to apply:** normalise inside the helper (`?.field ?? null`) and assert
`toBeNull()`, or return the whole doc and check the field outside `t.run`.
