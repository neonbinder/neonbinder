---
name: wait-line-mounting-breaks-test-mocks
description: Mounting WaitingOnMarketplaceRun in a component breaks its tests three ways — convex/react mocks without useQuery, ConvexProvider fake clients without watchQuery, and "exactly one status region" a11y pins; plus the 50-rows-per-key reader cap for many-call runs
metadata:
  type: reference
---

Adding `<WaitingOnMarketplaceRun>` (components/modules/WaitingOnMarketplace.tsx) to a component that never subscribed before breaks its existing tests in predictable ways (PR 451, NEO-487):

1. A `vi.mock("convex/react", () => ({ useAction, useMutation }))` with no `useQuery` export fails EVERY test at render ("No useQuery export is defined"). Add a `useQuery` that routes `"marketplaceWaits.forRun"` and add `marketplaceWaits: { forRun: "marketplaceWaits.forRun" }` to the api mock so a test can drive the line.
2. A hand-built fake client passed to a real `<ConvexProvider>` (query + action only) throws `convex.watchQuery is not a function` the moment the line goes active. Stub `watchQuery: () => ({ onUpdate: () => () => undefined, localQueryResult: () => <answer>, journal: () => undefined })`.
3. A11y tests that pin "exactly one status region of ours" count the wait line; filter it by `data-marketplace-wait`, never by text.
4. Exact `toEqual` on the action's args goes stale: add `waitKey: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/)`.

The line appears only after 1.5 s, so tests use real timers and `findByText(..., {}, { timeout: 3000 })`.

`marketplaceWaits.forRun` reads at most 50 rows per key (one row per BSC recorder, i.e. per action call), so a client loop issuing many BSC calls under one key must rotate keys before 50 (base-match-probe rotates at 40).

Related: [[component-tests-hand-build-the-api-mock]], [[visual-harness-fake-convex-client]].
