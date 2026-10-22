---
name: zod-union-hides-enum-errors
description: zod 3 reports a failed z.enum (any fatal issue) inside a z.union as a bare "Invalid input" on the union's path; a non-fatal z.custom refinement surfaces at the field with its message
metadata:
  type: reference
---

In zod 3 (apps/web pins 3.25), a `z.union` whose every branch fails returns the
first branch that failed only "dirty" (refinement issues) with those issues at
their real paths; if every branch ABORTED (a type/enum mismatch, or a fatal
custom issue) it returns one `invalid_union` issue, message "Invalid input", on
the union's own path. The setbuild spec's checklist `review` is
`"none-expected" | answers`, so a bad enum deep inside the answers reported
`steps[1].base.checklist.review: Invalid input` — nothing an operator can fix.

Fix used for the league `level` (NEO-339 merge of NEO-331):
`z.custom<T>(check, { message, fatal: false })` — `z.custom` defaults to
`fatal: true`, which aborts like an enum does. `superRefine` issues are
non-fatal by default and also surface correctly.

**How to apply:** any value constraint nested under a union in a spec/input
schema whose errors a human reads. Cost: zod-to-json-schema emits no `enum`
for a custom, so list the values in `.describe()`. Pin the reported path in a
test (`SpecError.issues[].path`), not just "throws".

Related: [[reference_mcp_stdio_server_pitfalls]].
