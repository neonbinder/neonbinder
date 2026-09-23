---
name: reference-convex-typecheck-excludes-test-files
description: `npm run typecheck` (convex/tsconfig.json) EXCLUDES ./**/*.test.ts, so changing a Convex function's args or return shape is green at the gate while every test call site is silently stale — only vitest catches it
metadata:
  type: reference
---

`apps/web/convex/tsconfig.json` sets `"exclude": ["./_generated", "./**/*.test.ts"]`
(deliberately — convex-test's generic DataModel typing degrades under the deploy
tsc and was failing the Vercel build repo-wide).

Consequence: **`npm run typecheck` cannot tell you that you broke a test's call
site.** Change a public function's `args` or `returns` and the gate stays green
while `expect(count).toBe(3)` in a co-located test is now asserting on an
object. Vitest does not typecheck either, so the only thing that catches it is
the assertion actually failing — which it will not, for shapes like `toBe`
against a truthy object, or a mocked client that returns a bare number.

So when changing a Convex signature:

1. `grep` every `api.<module>.<fn>` across `convex/**/*.test.ts` AND
   `components/**/*.test.tsx` and fix the call sites by hand.
2. In component tests the mocks are hand-built (see
   [[reference_component_tests_hand_build_the_api_mock]]) — a `vi.fn()` that
   resolved a number keeps "working" against a new object shape because
   `(0).hasMore` is `undefined` rather than a throw. Update the mock's resolved
   value to the real shape or the test proves nothing.
3. Run the touched test files explicitly, then the full `test:unit`.
