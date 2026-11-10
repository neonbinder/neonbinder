---
name: shared-component-precheck-survives-sibling-mocks
description: Adding a server pre-check to a widely mounted component (PlayerPicker) — use a "skip"-gated useQuery where undefined means "proceed", never useConvex(), or every sibling test's hand-built convex/react mock breaks
metadata:
  type: reference
---

A component mounted by many screens (PlayerPicker: card drawer, quick-add,
UnreviewedNameFixer) is rendered by dozens of test files, each with its own
`vi.mock("convex/react", …)` exporting only `useQuery`/`useMutation`.

- `useConvex()` for an on-demand read would be `undefined` in every one of
  those mocks and crash at render.
- A `useQuery` on a ref the sibling's api mock never lists receives
  `undefined` as its ref and the mock returns `undefined`.

So design the check so `undefined` (unanswered) means "carry on as before",
and let the server's structured refusal (`ConvexError` `data.code`) open the
same UI as the fallback. Gate the subscription on the moment it matters (NEO-463:
only while "+ Create" is offered) so a plain search never subscribes.

Also: a component taking a caller's ref should accept
`React.RefObject<T | null>` and use `panelRef ?? ownRef` as the `ref`; writing
`.current` of a passed `React.Ref` in a callback ref fails `react-hooks/immutability`.

Related: [[component-tests-hand-build-the-api-mock]].
