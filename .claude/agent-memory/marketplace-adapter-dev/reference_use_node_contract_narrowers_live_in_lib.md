---
name: use-node-contract-narrowers-live-in-lib
description: A narrower/type for a "use node" adapter's response that the default-runtime workpool settle must read goes in a pure convex/lib/ module, re-exported from the adapter; the validator is not re-exported from the Node file
metadata:
  type: reference
---

`adapters/preprocess.ts` is `"use node"`, but its results are first READ in
`placeholderPipeline.ts`'s workpool completion, a default-runtime mutation that
cannot import a Node module (it would pull google-auth-library into the V8
bundle). So any type, Convex validator or `unknown`-narrower for that response
lives in a pure `convex/lib/*.ts` (precedents: `lib/placeholderObjects.ts`,
`lib/preprocessWarmup.ts`, NEO-315's `lib/preprocessBaseline.ts`), and the
adapter re-exports the functions/types for Node callers. Keep Convex validators
out of the Node module's exports; schema.ts and internal function args import
them from lib directly.

Also: a new lib module needs its two lines in the tracked
`_generated/api.d.ts` by hand in a worktree ([[generated-api-needs-hand-edit-in-worktrees]]).

**How to apply:** before exporting a parser from an adapter, grep who reads the
value; if a non-`"use node"` file does, put it in lib.
