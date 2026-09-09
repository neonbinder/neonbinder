---
name: adapter-mocked-fixtures-hide-gate-divergence
description: Checklist tests that vi.mock the whole BSC/SL adapter let a seeded chain model a shape the real adapter refuses — so tightening a chain-level gate surfaces failures in fixtures, not in code
metadata:
  type: reference
---

`convex/fetchCardChecklist.*.test.ts` mostly `vi.mock("./adapters/buysportscards")`
and replace `fetchBscChecklist` wholesale. That mock never runs the adapter's own
required-facet lock, so a seeded `selectorOptions` chain can be a shape production
would refuse and the test still passes.

Concrete instance (found in NEO-252): `fetchCardChecklist.stickyPairing.test.ts`
seeded sport → year → setName → **insert**, with no `variantType` row at all. The
old chain gate walked NB levels and had no variantType row to find untagged, so it
called BSC; the real `fetchBscChecklist` would have refused the same request for
having no `variant` facet. The disagreement was invisible for as long as the two
gates were separate code.

**Why:** the chain gate (`resolvableSides`) and the adapter's boundary lock answer
the same question, and when they answer it differently the mocked tests side with
the gate. Making them share one function (`missingBscChecklistScope`) turns the old
divergence into red fixtures.

**How to apply:** when you tighten or unify a marketplace-reachability gate, expect
the first failures to be *fixtures modelling impossible chains*, not regressions —
check whether the seeded hierarchy could exist in production before "fixing" the
gate. Conversely, when adding a checklist fixture, seed the full
sport → year → (manufacturer) → setName → variantType → insert/parallel hierarchy
with a `variant`-tagged BSC slot, or it is testing a request BSC never receives.
Related: [[convex-components-unregistered-in-convex-test]].
