---
name: convex-test-hook-between-action-steps
description: To make something change BETWEEN two steps of a Convex action in convex-test, vi.mock a helper the earlier mutation calls (one-shot hook), or write via t.run inside the fetch stub when a fetch splits the steps
metadata:
  type: reference
---

An action that runs several `ctx.runMutation` steps (delete pages, then insert
pages) gives a test no seam between them: the adapters are mocked at the
action level, which is BEFORE the first write. To land a change exactly
between two steps (e.g. an operator moves `metadata.isBase` after the old
cards are deleted and before the copies go in), `vi.mock` a helper module that
the earlier mutation calls, keep the real export, and run a one-shot hook with
the mutation's own `ctx` after it:

```ts
const hook = vi.hoisted(() => ({ once: null as null | ((ctx: MutationCtx) => Promise<void>) }));
vi.mock("./cardPlayerLinks", async (orig) => {
  const actual = await orig<typeof import("./cardPlayerLinks")>();
  return { ...actual, deleteCardPlayerLinks: async (ctx: MutationCtx, id: Id<"cardChecklist">) => {
    await actual.deleteCardPlayerLinks(ctx, id);
    const f = hook.once; if (f) { hook.once = null; await f(ctx); }
  } };
});
```

The change commits in the same transaction as that step, so it is visible to
the next one. Assert `hook.once` is null afterwards to prove it ran. Put it
in its own test file: `vi.mock` is per file. The heavier alternative is the
`*Impl` + stub-ctx pattern, see [[action-impl-stub-ctx-for-write-failures]].

**Simpler when the gap is a `fetch`:** if the action's two steps are split by
an HTTP call (a query, then `fetch`, then the writing mutation), the
`vi.stubGlobal("fetch", ...)` stub itself is the seam: `await t.run(...)` inside
the stub writes the change (e.g. an operator's ruling landing mid-lookup), and
the later mutation sees it on its fresh read. Works from a plain `t.action`;
no `vi.mock`, no separate file.
