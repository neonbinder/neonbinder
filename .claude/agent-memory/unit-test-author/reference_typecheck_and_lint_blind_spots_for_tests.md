---
name: typecheck-and-lint-blind-spots-for-tests
description: Two gate gaps for test files in apps/web - typecheck excludes *.test.ts, and eslint ignores components/**/*.ts so a components .test.ts is both unlinted and uncollected
metadata:
  type: reference
---

- `npm run typecheck` (convex tsconfig) excludes `*.test.ts`. Deleting a public Convex query that a test still calls (`api.x.deletedQuery`) is green in typecheck and only fails in vitest at runtime. After deleting any exported function, grep every test dir for its name instead of trusting typecheck.
- eslint has no config for `components/**/*.ts` ("File ignored because no matching configuration was supplied"), and vitest never collects a `.test.ts` under `components/`. A helper test for a `.ts` module in `components/` must be named `.test.tsx` to run at all, and the helper itself is unlinted.
- For a duplicate-key regression, spy `console.error` in `beforeEach` and assert in `afterEach` that no call matches `/same key|unique "key"/i`. It turns every test in the file into a key-collision probe (React 19 reports it via console.error, not a throw).
- A "filtered list vs full list" regression (a derived label computed from the visible rows) is only caught by a fixture where the filter HIDES one of the twins (e.g. one mapped on a restored Ready set); a filter that keeps every twin visible stays green under the bug.

Related: [[reference_neo91_sku_and_sl_setradioid_wiring]].
