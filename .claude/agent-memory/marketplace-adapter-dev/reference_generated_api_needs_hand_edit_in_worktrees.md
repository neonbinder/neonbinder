---
name: generated-api-needs-hand-edit-in-worktrees
description: convex/_generated/api.d.ts is committed and enumerates modules; a NEW convex module fails typecheck until it is added there, and `npx convex codegen` refuses in a worktree with no CONVEX_DEPLOYMENT — add the two lines by hand
metadata:
  type: reference
---

`apps/web/convex/_generated/api.d.ts` is committed and lists every function
module by name (`import type * as foo from "../foo.js"` + `foo: typeof foo` in
`fullApi`). A brand-new `convex/<module>.ts` typechecks fine on its own, but any
`internal.<module>.x` / `api.<module>.x` reference fails with "Property does
not exist" until the module is listed there.

**How to apply:** `npx convex codegen` (safe, local-only, never deploys) is
the proper fix, but it exits "No CONVEX_DEPLOYMENT set" in a fresh worktree
without `.env.local`. When you cannot run it, hand-add the import line and the
`fullApi` entry in alphabetical position (two lines per module) — the
coordinator's `convex dev`/deploy will regenerate identically. Bundle-check a
JSON or cross-runtime import with `node_modules/.bin/esbuild <file> --bundle
--platform=node|browser --external:convex` as a proxy for the Convex bundler.

**The reverse is silent.** `api.d.ts` is a `.d.ts` and the convex tsconfig
sets `skipLibCheck`, so an entry whose module file does NOT exist yet (or was
deleted) typechecks green and every `internal.<module>.x` through it is `any`.
Typecheck proves nothing about a reference to a module you are about to
write; re-run it after the file exists.

Related house rule: a V8 module (no `"use node"`) cannot import a `"use node"`
module, so validators shared between the node adapter and a V8 action file
live in a pure module (e.g. `adapters/enrichmentFixtures.ts`) and the V8 side
reaches node-only bodies via `ctx.runAction(internal.adapters.<node>.<fn>)`.
