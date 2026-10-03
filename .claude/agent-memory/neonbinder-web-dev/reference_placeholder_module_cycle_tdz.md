---
name: reference-placeholder-module-cycle-tdz
description: placeholderPipeline.ts and placeholderHeavyPool.ts (and placeholderPool.ts) import each other, so a const shared across them is in its TDZ whenever the other loads first; put shared validators/helpers in a pure lib/ module
metadata:
  type: reference
---

`convex/placeholderPipeline.ts` imports `placeholderPool.ts` and `placeholderHeavyPool.ts`, and both of those import `findJob`/`recordImageOutcomeImpl` back from the pipeline. Only `function` declarations survive that cycle (they hoist — the pipeline's own comments say so). A `const` validator exported from one and read at module load by the other (e.g. inside `internalMutation({ args: { x: v.optional(thatValidator) } })`) throws a TDZ ReferenceError whenever the importing side happens to load second — order-dependent, so it can pass in one test file and fail in another or at deploy.

**How to apply:** a validator or helper that more than one placeholder module (or the `"use node"` `placeholderBatch.ts`) needs goes in a pure `convex/lib/*.ts` module — NEO-315's `lib/preprocessBaseline.ts` (`preprocessBaselineValidator`, `readEscalationHints`) is the model. A type-only import across the cycle is fine (erased). Don't hand-copy the validator into the Node module either; a pure lib module is importable from both runtimes.

Related: [[reference-client-imports-from-convex-only-pure-modules]]
