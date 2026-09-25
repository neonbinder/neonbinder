---
name: rerender-same-element-bails-out
description: In a component test whose mocked useQuery reads module state, `rerender(ui)` with the SAME element object renders nothing new (React bails out); build a fresh element per rerender. Also: a polite live region repeating visible text makes getByText find two.
metadata:
  type: reference
---

Component tests here mock `convex/react` so `useQuery` returns module-level
state (`review = …`), and simulate a reactive update by changing that state and
calling `rerender`. If the helper does `const ui = <X … />; rerender(ui)`, the
second render receives the identical element object and React bails out: the
component never re-reads the mock, and the "reactive" assertion fails as if the
feature were broken. Build the element in a function (`const ui = () => <X/>;
rerender(ui())`).

**Why:** NEO-306 SlSetReviewModal tests for "rows another admin's save removed
drop out" failed until the helper built a fresh element; the component was fine.

**How to apply:** any `rerenderSame`-style helper returns `utils.rerender(ui())`.
Second trap from the same file: a dialog that announces busy states and results
in a polite live region renders the SAME sentence twice (the visible line and
the sr-only region), so `getByText` throws "multiple elements". Filter with
`el.closest("[aria-live]") === null` rather than dropping the live region.

Related: [[component-tests-hand-build-the-api-mock]].
