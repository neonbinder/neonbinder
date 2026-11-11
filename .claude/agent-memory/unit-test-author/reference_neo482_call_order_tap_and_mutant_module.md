---
name: neo482-call-order-tap-and-mutant-module
description: Asserting the ORDER an action calls two internal mutations in convex-test (wrap `_handler`, not invokeMutation), and break-checking a source a parallel builder owns without editing it (mutant copy swapped in via the modules glob)
metadata:
  type: reference
---

- **Call order of internal mutations from an action**: swap the module in the
  convex-test registry and wrap each function's `_handler`
  (`Object.assign(() => undefined, real[name], { _handler: (ctx, a) => { order.push(name); return real[name]._handler(ctx, a); } })`).
  convex-test resolves `getHandler(func)` = `_handler` and builds its own
  `mutationGeneric` around it, so wrapping `invokeMutation` records nothing.
  Validators still come from the copied `exportArgs`.
- **Break-check without touching a builder's file**: write the mutant to a
  temp `convex/zz_<ticket>_mutant.ts` (same dir, so relative imports resolve),
  temporarily add `modules["./testing.ts"] = modules["./zz_..._mutant.ts"];`
  under the test file's glob line, run `-t <describe>`, then restore the test
  file from in-memory bytes and delete the mutant in a `finally`. HEAD's copy
  (`git show HEAD:<path>`) is a free "pre-build" mutant.
- `t.run` returning `undefined` comes back as `null`: assert `?? null` / `toBeNull()`.
- A BSC seller session in a convex-test action needs two stubbed routes: the
  browser service `GET /credentials/buysportscards-credentials-<user>/token`
  (`{token, expiresAt}` an hour ahead) and `https://api-prod.buysportscards.com/<path>`.
  Simulate the 5 s bound by throwing an Error named `TimeoutError`; no fake timers.
- Session close is observable as one `bsc_call_summary` console.log line with
  the opener's `op`.

Related: [[neo325-twin-test-patterns]], [[placeholder-pairing-race-tests]].
