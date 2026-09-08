---
name: convex-codegen-only-blocks-types
description: Missing Convex codegen blocks ONLY tsc, never vitest/convex-test — api.js is anyApi/componentsGeneric proxies, so new functions and components resolve at runtime without running a deploying CLI command
metadata:
  type: reference
---

When you add a new Convex module (or a component via `convex.config.ts`) and cannot
run codegen — the repo rule is that `npx convex codegen` / `npx convex dev` deploy to
the dev deployment, so they need explicit approval — the block is **types only**.

`apps/web/convex/_generated/api.js` is:

```js
export const api = anyApi;
export const internal = anyApi;
export const components = componentsGeneric();
```

All three are runtime Proxies that build function-path strings on property access.
`api.d.ts` is the only stale artifact.

**How to apply:**
- You can write the full feature and a complete convex-test suite, and it will PASS.
  `t.mutation(internal.myNewModule.myFn, …)` and `new Workpool(components.myPool, …)`
  both resolve. Do not wait on codegen to validate the work.
- `tsc --noEmit` will be red with `TS2339: Property 'myNewModule' does not exist on
  type '{ selectorOptions: … }'` (and `'preprocessPool' does not exist on type '{}'`
  for components). Expect a cascade too: an untyped `ctx.runQuery(...)` result comes
  back as `{}`, producing TS2339 on its fields and TS7006 implicit-any on `.map()`
  callbacks. All of it clears in one shot when codegen runs.
- To report typecheck state honestly, separate those from real errors by filtering
  the codegen signatures out of the tsc output rather than eyeballing the count.
- Component constructors (e.g. `@convex-dev/workpool`'s `Workpool`) just assign
  `this.component`, so a module-level `new Workpool(components.x, …)` is safe to
  import under convex-test even though the component is not mounted. Only an actual
  `enqueue*` / `cancel` call would reach the missing component.

Related: [[vercel-build-runs-convex-typecheck]] — the Vercel build DOES run the
Convex typecheck (`convex/tsconfig.json`, which excludes `*.test.ts`), so
codegen-pending errors in non-test Convex modules will fail that build. They must be
resolved before push, not left for CI to find.
