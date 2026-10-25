---
name: typecheck-a-client-against-a-contract-stub
description: When the backend is built in parallel, missing api members make the client `any` and hide real bugs; typecheck the client against a scratch stub of the contract via tsconfig paths
metadata:
  type: reference
---

In a parallel build, `api.<newModule>` and new `api.collection.*` members don't exist in the tracked `convex/_generated/api.d.ts` yet. tsc fails on those references, and every value that flows from them becomes implicit `any`, so a real mistake in the client (wrong arg name, Id vs string, a missing field) stays hidden.

**How to apply:** in the scratchpad, write `api-stub.ts` that re-exports the real `api` with `Omit<typeof real.collection, ...> & { newFn: FunctionReference<"query"|"mutation","public",Args,Ret> }` for each contract function (generic `Q<A extends DefaultFunctionArgs, R>`). If needed, add a `collection-stub.ts` that re-exports the real module with widened validators (`v.object({...real.copyValidator.fields, slot: v.optional(v.number())})`). Add a scratch `tsconfig.json` that `extends` the app's, maps `"@/convex/_generated/api"` and `"@/convex/collection"` to the stubs ahead of `"@/*"`, and lists only the client file in `files`. Symlink the app's `node_modules` into the stub dir, or `convex/values` won't resolve. Don't use `baseUrl`: TS 6 rejects it. Then fix whatever the stub run reports.

Arg types: existing catalog/collection args take ids as `v.string()` (variantId, setId), not `v.id(...)`. Mirror that in the stub, or you get false reds.

Related: [[convex-codegen-only-blocks-types]], [[apps-web-root-tsc-is-red-at-baseline]].
