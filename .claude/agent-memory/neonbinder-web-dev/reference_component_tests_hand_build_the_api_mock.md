---
name: component-tests-hand-build-the-api-mock
description: apps/web component tests mock `_generated/api` as a partial literal and mock sibling components with only `default` — so `api.<newModule>.<fn>` in a component throws "Cannot read properties of undefined" in every existing test of it, and a named export from a component file breaks the module tests that mock it. Route domain reads through slot props, keep sentinels in pure modules, and add the module key to the api mock only where the read must live in the component.
metadata:
  type: reference
---

Two shapes of the same trap, both hit on NEO-237:

1. **`api` is a hand-built partial object in every component test**
   (`vi.mock("../../convex/_generated/api", () => ({ api: { selectorOptions: {…} } }))`).
   The first `useQuery(api.brandView.x)` / `useMutation(api.setDiscovery.y)` added
   to a component that already has tests fails ALL of them at render with
   `TypeError: Cannot read properties of undefined (reading 'x')` — 91 of 102 in
   `SetAttributesPanel.test.tsx`, before a single assertion runs. The existing
   queries in those components survive only because the mock's `useQuery` returns
   a catch-all and the component shape-guards the result.

2. **`vi.mock("../SetSelector/X", () => ({ default: … }))` returns only `default`.**
   A constant or type exported alongside a component (a client sentinel, a
   selection union) breaks every module test that mocks that component:
   `[vitest] No "isAllBrandsView" export is defined on the "…" mock`.

**How to apply:**
- Prefer a design that keeps the new module out of the tested component: a
  domain-specific control that owns its own `useQuery`/`useMutation`, handed in
  through a slot prop (`EntityColumn`'s `extraActions` / `extraPills`). The
  container never learns the module, and the tests that stub the container's
  children never render the control. This is also the better design — the
  column should not learn a domain it does not own.
- Put sentinels and shared types in a pure module (`all-brands-view.ts`), not in
  the component file; import from there in the container.
- When the read genuinely belongs in the tested component (a save on the
  Attributes panel), add the module key to that test's api mock — one block,
  with a `// NEO-nnn` comment, beside the `teamFill` block NEO-279 added the same
  way. Say so in the report: it is a test-file edit outside a builder's list.
- `onSelect(id)`-style callbacks are asserted with `toHaveBeenCalledWith(id)`
  EXACTLY in the listbox/keyboard tests; adding a second argument breaks them.
  Look the extra datum up from a deduped `useQuery` in the wrapper instead.
