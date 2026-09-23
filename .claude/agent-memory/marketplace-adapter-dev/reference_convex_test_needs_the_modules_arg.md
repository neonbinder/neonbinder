---
name: convex-test-needs-the-modules-arg
description: convexTest(schema) without the import.meta.glob modules arg throws "(intermediate value).glob is not a function" — a misleading error that reads like a Vite/config problem, not a missing argument
metadata:
  type: reference
---

`convexTest(schema)` **must** be called as `convexTest(schema, modules)` in this
repo, where `modules` is the house boilerplate at the top of every convex test:

```ts
const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");
```

Omitting the second argument does not fail with "missing argument". It throws
`TypeError: (intermediate value).glob is not a function` from inside
`convex-test/dist/index.js` (`moduleCache`), on the `convexTest(...)` line —
which reads exactly like the unrelated Vite warning vitest prints on every run
(`Your Vite config uses features unsupported by configLoader: 'native'` …
`__dirname`). Easy to spend a cycle on the wrong file.

**How to apply:** when every test in a new convex-test file fails at the
`convexTest(` line with a `.glob` TypeError, add the `modules` argument before
investigating anything else. Copy the whole file's boilerplate from a sibling
test rather than the `convexTest` call alone.

Related: [[convex-test-read-budget-by-construction]].
