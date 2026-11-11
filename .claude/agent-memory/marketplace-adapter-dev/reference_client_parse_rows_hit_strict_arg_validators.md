---
name: client-parse-rows-hit-strict-arg-validators
description: A field added to a client-side parser's row type reaches a Convex action's v.object arg unfiltered; Convex refuses extra fields at runtime while tsc stays green
metadata:
  type: reference
---

When a pure client parser (e.g. `lib/checklists/parse-published-checklist.ts`)
gains a row field, check where the rows go: UI code often passes the parsed
rows straight into an action arg (`publishedChecklist: { rows }`). Convex's
`v.object` rejects unknown fields at runtime ("Object contains extra field"),
and the TS types usually still line up because the client type is structural.

**How to apply:** either widen the arg validator with `v.optional(...)` and
drop the field in the server's re-check (safe across deploy skew: old clients
never send it), or strip it at the call site. Widening at the server is the
one that cannot be forgotten by a later UI change. Pin it with a convex-test
that sends the field. Related: [[narrowing-convex-validator-is-a-runtime-break]].
