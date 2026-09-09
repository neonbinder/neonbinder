---
name: resilient-column-gaveup-signature
description: Forensic signature for "No visible element found: id: Add custom <Level>" in set-selector flows — the NEO-83 ResilientEntityColumn give-up state, how to confirm it from a screenshot + 27s timing math, and why it is terminal
metadata:
  type: reference
---

A set-selector flow failing with `No visible element found: id: Add custom <Level>`
(Sports / Years / Manufacturers / Sets / Variant Types) is **not always** a scroll,
clipping or coordinate-staleness problem. Check the give-up state FIRST — it is
cheap to rule in/out and it looks nothing like a layout bug.

**Confirm from the debug screenshot:** the column renders its heading plus a red
`role="alert"` box reading *"Couldn't load &lt;level&gt;. The connection may have
stalled."* and a **Retry** button, where the `Sync X` / `+ Custom` action row
should be. That is `ResilientEntityColumn`'s `gaveUp` branch
(`apps/web/components/SetSelector/ResilientEntityColumn.tsx`).

**Confirm from the timing math:** `SELECTOR_OPTIONS_STALL_BACKSTOP_MS = 9_000` and
`MAX_RESUBSCRIBE_ATTEMPTS = 2` → the column gives up at **exactly ~27s** after the
parent row is tapped. In maestro.log, measure `Tapping on element … text=<parent>`
→ the first `Assert that "<Column Header>" is visible COMPLETED`. The heading is
gated on the read (`EntitySelector` renders "Loading &lt;level&gt;…" while
`items === undefined`), so the heading *first appearing at +27s* IS the give-up
render, not a slow-but-successful load. A healthy read is ~1.5–2s.

**Why it is terminal / never self-heals:** the `gaveUp` branch returns the error
`<div>` *instead of* `<EntityColumn>`, so the `getSelectorOptions` subscription is
unmounted entirely. `gaveUp` is only ever reset by `handleRetry` (a human clicking
Retry). A value delivered later, or a Convex websocket reconnect, cannot clear it.
So a transient ~27s read stall becomes a permanent dead-end for any automated flow
— and every flow that drills that column afterwards fails hard.

**Do not "fix" this in YAML.** A longer `timeout:` cannot help (the button is gone
for good), and tapping Retry from a flow would hide a real product dead-end.
`convex@1.42` exposes `useConvexConnectionState()` — re-arming the backstop on
reconnect (or keeping EntityColumn mounted beneath the banner) is the app-side fix.
Related: [[reference_flake_runtime_forensics]].
