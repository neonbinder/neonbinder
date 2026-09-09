---
name: teardown-leak-attribution
description: How to attribute and fix a convex-test EnvironmentTeardownError — the trace's third frame names the test file, the module name is a red herring, it reproduces ~1 full run in 3
metadata:
  type: reference
---

**The module in the message is not the clue; the third stack frame is.**

```
Cannot load '/convex/lib/pairing/pool.ts' imported from …/pairBatch.ts …
The last recorded callstack:
- /convex/lib/pairing/pool.ts        <- how far module loading got
- …/convex/lib/pairing/pairBatch.ts  <- its importer
- …/convex/placeholderEscalation.test.ts   <- THE CULPRIT
```

`pool.ts` and `pairBatch.ts` are one import chain, one level apart. Two runs
naming different modules for the same scheduled function is **not** evidence of
two scheduling sites — it is module-cache state. Always read the frame that ends
in `.test.ts`.

**It is load-dependent.** On this Mac it appears in roughly **one full
`npm run test:unit` in three**, and in **zero** single-file runs — even with every
drain in the file deliberately removed. So: never conclude "fixed" from one green
full run, and never conclude "not this file" from a clean isolated run. Budget
3+ full runs.

**Grep-led surveys miss files.** `placeholderCounterRace.test.ts` and
`placeholderEscalation.test.ts` both leaked `placeholderPairing:runPairing`
without containing the string `runPairing` — they drive `recordImageOutcomeImpl`,
and a batch whose last image settles schedules it. Trace the SOURCE call graph
(what does the mutation under test schedule?), not the test's own text.

**Direct probe that works** — reading the system table does NOT drain the queue:

```ts
await t.run(async (ctx) =>
  (await ctx.db.system.query("_scheduled_functions").collect())
    .filter((j) => j.state.kind === "pending" || j.state.kind === "inProgress")
    .map((j) => j.name),
);
// => [["placeholderPairing:runPairing","pending"]]
```

A global `afterEach` probe injected into every test file reported **zero** hits
while this same in-test read showed a pending job — hook ordering makes the
blanket approach unreliable. Probe inside the test body.

Drain vs cancel: see [[convex-components-unregistered-in-convex-test]]. Drain when
the work is pure and local; cancel when it reaches an unmounted component, when
the test asserts the scheduled ROWS rather than their effect, or when the chain is
too long for convex-test's iteration ceiling.
