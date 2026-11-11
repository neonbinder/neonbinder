---
name: convex-test-spy-handler-to-count-calls
description: To prove a nested ctx.runQuery/runMutation never ran in convex-test, spy the registered function's `_handler`, never `invokeQuery`; always pair with a positive control
metadata:
  type: reference
---

convex-test resolves a nested `ctx.runQuery(internal.x.y)` through
`getHandler(func)`, which returns `func._handler`. `vi.spyOn(mod.y, "invokeQuery")`
is blind: it stays at 0 calls while the read happens, so a "never read" assert
passes vacuously. Spy `_handler` instead:

`vi.spyOn(mod.y as unknown as { _handler: (...a: unknown[]) => unknown }, "_handler")`
with `import * as mod from "./x"` (same module instance as the convex-test glob).

**Why:** caught only because the live-row control asserting exactly one read
went red (NEO-482, cooldown read in `runBscTeamCheckItem`).

**How to apply:** every "no read / no call" assertion gets a sibling test where
the call must happen and the spy counts it. Related: [[pin-tests-need-a-bypass-plant]],
[[convex-test-read-budget-by-construction]].
