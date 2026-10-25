---
name: prototype-shared-types-are-live-do-not-edit-them
description: The five collection prototypes (/collection/1-5) are still routed and import prototypes/_shared/{types,data}.ts; a final/ feature never changes those shapes, it adapts at the demo-store boundary (final/data/demoStore.ts)
metadata:
  type: feedback
---

NEO-359 planning (2026-10-24): `apps/web/app/collection/final/` still leans on
`prototypes/_shared/types.ts` (`Copy.binderIds`, `forSale`, `askPrice`,
`Binder.layout`) and `prototypes/p2/model.ts`, while `src/main.tsx` still
routes p1-p5 as live reference pages that share those files.

**Why:** editing a shared prototype shape to fit the real model breaks five
routed pages nobody is testing; the demo store already exists to translate
fixture copies into the view model.

**How to apply:** when the real model diverges (one home per copy, trade as a
flag, boxes), put the new shape in `final/data/types.ts`, translate inside
`final/data/demoStore.ts` and the demo reducer (`final/store.ts`), and give
shared components optional props rather than changed ones. Done criterion:
`git diff --stat apps/web/app/collection/prototypes/` is empty except for
backwards-compatible optional props.
