---
name: reference-vi-mock-a-constant-needs-a-getter
description: Lowering a module-level cap (MAX_*) for a convex-test run via vi.mock — spread the original and expose the constant as a GETTER, or the value freezes at import and per-test changes are ignored
metadata:
  type: reference
---

When a behaviour is gated on a module constant that is far too large to seed
past in a test (`MAX_YEAR_SET_ROWS = 3000` in `convex/setFromMarketplace.ts`,
and its kind), mock the constant rather than building the fixture. The module
must be a PURE helper module — one that registers no Convex functions — or the
mock has to re-register them and drifts.

The shape that works:

```ts
const mockState = vi.hoisted(() => ({ maxYearSetRows: 1 }));

vi.mock("./setFromMarketplace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./setFromMarketplace")>();
  return {
    ...actual,
    get MAX_YEAR_SET_ROWS() { return mockState.maxYearSetRows; },
  };
});
```

**A plain `MAX_YEAR_SET_ROWS: mockState.maxYearSetRows` freezes the value at
module evaluation.** A later test that raises or restores the cap (the control
case — "and with the cap NOT tripped, the phase still does its job") silently
keeps the first value, and `vi.resetModules()` does not help because
convex-test has already built its module registry from `import.meta.glob`. The
getter is read on every access, so the consumer's `const remaining = MAX - n`
sees the current value.

The paired control test is the point of being able to change it at run time: a
"nothing was written" assertion passes just as well against a function that has
stopped writing altogether, so the same file must also assert the untripped
path still writes, and where.
