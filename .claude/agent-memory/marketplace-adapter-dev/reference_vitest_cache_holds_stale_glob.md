---
name: vitest-cache-holds-stale-glob
description: "Could not find module for: <new module>" from convex-test in an UNCHANGED test file means vitest's transform cache holds an import.meta.glob result from before the module existed; any edit to the test busts it
metadata:
  type: reference
---

convex-test resolves functions through the `modules` map built by
`import.meta.glob("./**/*.*s")`. Vite expands that glob at transform time and
vitest caches the transformed file (the cache dir is shared between
worktrees through the symlinked `node_modules`). A test file that has not
changed since before a new Convex module was added can keep the OLD map, and
any call that reaches the new module fails with
`Could not find module for: <module>` although the file is on disk and other
tests reach it.

**How to apply:** when that error names a module that exists, change the test
file's content (a header comment is enough) and rerun; or run vitest with
`--no-cache`. Do not chase it in the module or in `_generated/api.d.ts`
([[generated-api-needs-hand-edit-in-worktrees]] is a different failure).
