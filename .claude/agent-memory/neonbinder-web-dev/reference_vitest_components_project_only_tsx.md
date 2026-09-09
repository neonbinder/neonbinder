---
name: vitest-components-project-only-tsx
description: apps/web's `components` vitest project globs only `*.test.tsx`, so a pure-logic `.test.ts` next to a component is never collected — name co-located pure tests `.test.tsx` even with no JSX
metadata:
  type: reference
---

`apps/web/vitest.config.ts` defines two projects with disjoint globs:

- `convex-lib` — `convex/**/*.test.ts`, `lib/**/*.test.ts`, `scripts/**/*.test.mjs`
- `components` — `components/**/*.test.tsx`, `src/**/*.test.tsx`, `app/**/*.test.tsx`

Nothing collects `components/**/*.test.ts`. So a pure helper extracted next to a
component (`components/SetSelector/pairing-session-edits.ts`) and tested as
`pairing-session-edits.test.ts` is **collected by no project at all**.

**Why it matters:** `npx vitest run <that file>` fails loudly ("No test files
found", exit 1), but in a whole-suite run it is simply absent — a green
`npm run test:unit` with the file silently never executed. That is the failure
mode worth remembering; the direct-invocation error is the friendly case.

**How to apply:** when co-locating a test for a pure module under
`components/`, name it `*.test.tsx` even though it contains no JSX (verified
2026-09-04 on NEO-220 WP-B). Keep the *source* module `.ts` — only the test file
needs the extension. Moving the module under `lib/` instead would also work, but
then it loses colocation with the component that owns its types.

Related: [[eslint-flat-config-skips-ts]] (the same shape one layer over: a plain
`.ts` under `apps/web` is linted by nothing either).
