---
name: reference-convextest-modules-glob-must-be-convex-root
description: import.meta.glob for convex-test's modules registry must be called from a file directly under convex/ (never a subdirectory like convex/adapters/) or function path resolution silently breaks; how to force an action to throw for tolerance tests when the real code swallows every realistic error.
metadata:
  type: reference
---

## `convexTest(schema, modules)`'s `modules` glob MUST be called from convex/ root

Every `convexTest`-based test file in this codebase uses:
```ts
const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");
```
This works ONLY when the test file itself lives directly under `convex/`
(e.g. `convex/teamBackfill.test.ts`, `convex/backfillCardFeatures.test.ts`).
`convex-test`'s `findModulesRoot` derives a path "prefix" from wherever
`_generated/` shows up in the glob's keys, then looks up every function by
`prefix + relativePathFromConvexRoot`. Vite's `import.meta.glob` returns
keys as the **shortest relative path from the calling file's own
directory** — so a file in the SAME directory as the caller loses its
subdirectory prefix (e.g. calling from `convex/adapters/foo.test.ts` with
`"../**/*.*s"` yields `"./buysportscards.ts"` for a sibling file, not
`"adapters/buysportscards.ts"`), while parent-root files gain `"../"`
prefixes instead. This silently breaks convex-test's `prefix + path`
scheme for ANY function whose module lives in the same subdirectory as the
test file, producing `Error: Could not find module for: "adapters/foo"` at
call time (not at glob time — the mismatch is invisible until you actually
invoke `t.action`/`t.mutation`/`t.query` on that path).

**Consequence**: don't write `convexTest`-based tests for functions defined
in `convex/adapters/*.ts` from a test file inside `convex/adapters/`. Put
that test file at `convex/<name>.test.ts` (root) instead, even though the
source lives in a subdirectory — `internal.adapters.buysportscards.foo`
resolves fine when the GLOB CALLER is at convex root, regardless of where
the actual source file sits. Established while adding
`bscTeamEnrichmentQueue.test.ts` for NEO-90's `resolveBscCardTeam`/
`processBscTeamEnrichmentQueue` actions (source in
`convex/adapters/buysportscards.ts`) — confirmed by probing
`Object.keys(modules)` directly in a throwaway test before diagnosing the
root cause, rather than guessing. `convex/adapters/buysportscards.test.ts`
itself is fine specifically because it never calls `convexTest` — it only
unit-tests the pure `parsePlayersField` helper.

## Convex's own arg validator throws BEFORE the handler runs — can't use a malformed ID mid-array to simulate an internal throw

`v.id("cardChecklist")` (including inside `v.array(v.id(...))`) is
validated at the function's entry boundary, for every element, before the
handler body executes at all. Passing a garbage string (or a real ID from
the wrong table) as one entry in an array arg makes the ENTIRE outer call
throw immediately — it can't be used to simulate "this one card's internal
processing throws but the rest of the array is still attempted," because
the handler (and its own internal `ctx.runAction`/`ctx.runMutation` calls)
never even starts. Confirmed empirically: `t.action(someAction, { ids:
["not-a-real-id", goodId] })` throws a `Validator error: Expected ID for
table...` synchronously at the `t.action(...)` call site, not deferred
into the handler.

Also confirmed: `ctx.db.get(id)` on a well-formed-but-nonexistent ID
returns `null` (no throw) — that's the normal "row was deleted" case, not
a throw-inducing one either.

## How to actually force a "one item throws, chain continues" test when the real code swallows every realistic error

`resolveBscCardTeam` (NEO-90) deliberately catches every externally
reachable failure (bad HTTP response, network error, JSON parse error) and
returns `null` instead of throwing — by design, so the enrichment queue
never wedges. That means `processBscTeamEnrichmentQueue`'s own
`try/catch` around `ctx.runAction(resolveBscCardTeam, ...)` has NO
reachable trigger via fetch-stub inputs alone. The only way found to
genuinely exercise that outer catch: a file-scoped `vi.mock` that replaces
the action's module export with a still-valid `internalAction(...)` whose
handler just `throw`s:

```ts
vi.mock("./adapters/buysportscards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/buysportscards")>();
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    resolveBscCardTeam: internalAction({
      args: { cardChecklistId: v.id("cardChecklist") },
      returns: v.null(),
      handler: async (): Promise<null> => { throw new Error("simulated failure"); },
    }),
  };
});
```
This works because convex-test's lazy module loaders (from
`import.meta.glob`) are just sugar over dynamic `import()`, which Vitest's
`vi.mock` intercepts across the whole module graph — including the
`internal.adapters.buysportscards.resolveBscCardTeam` FunctionReference
that `processBscTeamEnrichmentQueue` calls via `ctx.runAction`. Confirmed
via a throwaway probe test before committing to this design.

**Isolate this in its OWN test file.** `vi.mock` is hoisted and
file-scoped in Vitest — mocking `resolveBscCardTeam` for the whole file
would break every other (real-fetch-based) test of the same action in a
sibling file. See `convex/bscTeamEnrichmentQueue.tolerance.test.ts`
(isolated) vs. `convex/bscTeamEnrichmentQueue.test.ts` (real fetch stubs,
no mock) — same describe target, split across two files purely for this
reason.

Related: [[reference-generatelisting-wiring-integration-tests]] (chained
queue draining via `finishAllScheduledFunctions(vi.runAllTimers)`, same
pattern as `convex/backfillCardFeatures.test.ts`).
