---
name: required-field-flip-breaks-test-fixtures
description: Flipping a Convex field optional→required breaks every raw ctx.db.insert fixture in convex tests (convex-test validates against the schema), plus every test that relied on a writer creating the row from a name
metadata:
  type: reference
---

convex-test validates `t.run(ctx => ctx.db.insert(...))` against `schema.ts`, so an optional→required flip turns every raw fixture insert of that table into "Validator error: Missing required field". The typecheck gate will not warn you: convex/tsconfig excludes `*.test.ts` (see [[convex-typecheck-excludes-test-files]]).

How to apply:
- Before running anything, `grep -rn 'insert("<table>"' convex/*.test.ts` and fix fixtures in one mechanical pass (a brace-matching script that adds the field only where the object lacks it; helpers with `...(opts.x ? {x} : {})` become `x: opts.x ?? <default>`). NEO-331 (`leagues.level`) touched ~27 sites in 16 files.
- Mutation args that became required (e.g. `createByAdmin({ level })`) fail at ARG VALIDATION, before the auth check. Auth-guard tests (`publicFunctionAuth*.test.ts`) then pass for the wrong reason. Add the arg so the test still reaches the guard.
- When "find-or-create by name" paths become link-only, tests that relied on the name minting a row go red with `undefined` league names. Seed the row when the test is really about precedence. Rewrite the assertion only where the test pinned the old creation behaviour, and say so in a comment.
- A required field on rows also removes "unset" branches (sort-last ranks, null-clear args). Grep `=== undefined` near the field by hand.
