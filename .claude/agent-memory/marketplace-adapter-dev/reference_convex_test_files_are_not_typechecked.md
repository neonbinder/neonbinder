---
name: convex-test-files-are-not-typechecked
description: `npm run typecheck` uses convex/tsconfig.json, which EXCLUDES ./**/*.test.ts, and eslint skips plain .ts, so a Convex test file's type errors are gated by nothing; typecheck new tests with a scratch tsconfig
metadata:
  type: reference
---

`apps/web/convex/tsconfig.json` has `"exclude": ["./_generated", "./**/*.test.ts"]`
(deliberately: the deploy typecheck runs over it, and convex-test's generic
DataModel typing degrades there). vitest does not typecheck either, and eslint
visits no plain `.ts` ([[eslint-does-not-cover-plain-ts]]). So an implicit
`any` or a wrong type in a `convex/**/*.test.ts` passes every gate. The base
already carries at least one such error (an untyped `(call) =>` over
`vi.spyOn(...).mock.calls`).

**How to apply:** after writing or editing Convex tests, typecheck just those
files with a scratch config (in the scratchpad, never committed):

```json
{ "extends": "<worktree>/apps/web/convex/tsconfig.json",
  "compilerOptions": { "noEmit": true },
  "include": ["<abs path to each test file>"], "exclude": [] }
```

run as `npx tsc -p <scratch>/tsconfig.tests.json` from `apps/web`. Fix errors
in lines you wrote; report pre-existing ones rather than drive-by fixing.
Typing a console-spy helper parameter as `{ mock: { calls: unknown[][] } }`
avoids the implicit-any that `ReturnType<typeof vi.spyOn>` produces.
