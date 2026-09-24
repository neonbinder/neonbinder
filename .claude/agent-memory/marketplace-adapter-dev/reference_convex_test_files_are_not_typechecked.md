---
name: convex-test-files-are-not-typechecked
description: convex/tsconfig.json excludes *.test.ts, so `npm run typecheck` never sees test types; vitest strips them; grep root tsc output for your test files instead
metadata:
  type: reference
---

`npm run typecheck` is `tsc -p convex/tsconfig.json`, and that tsconfig excludes `./**/*.test.ts`. Vitest transpiles without type checking, and eslint ignores `convex/` too (see [[eslint-does-not-cover-plain-ts]]). So a type error in a Convex test file passes every gate.

**How to apply:** after writing a Convex test, run `npx tsc -p . --noEmit 2>&1 | grep <your test file>`. The root tsc is red at baseline, so grep for your file; never treat the whole run as a gate. A common hit: `ctx.db.query(...).withIndex("by_level_and_parent", ...)` inside `t.run` when `t` is typed `ReturnType<typeof convexTest>` loses the schema's index types. Use `.collect()` + `.filter()` in test helpers, or type `t` from `convexTest(schema, modules)`.
