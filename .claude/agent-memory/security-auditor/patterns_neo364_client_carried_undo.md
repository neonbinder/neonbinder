---
name: patterns-neo364-client-carried-undo
description: Public mutation that applies a client-supplied undo "inverse" (step list) — the validation shape that held, the read-amplification gap, and the armed page mutation that skipped the re-arm
metadata:
  type: project
---

NEO-364 `collectionInventory.undoBoxQuantity` takes the `inverse` a prior
write returned and applies it. The client can forge any inverse, so audit it
as a raw write API, not as "the undo".

What held (re-check on any edit):
- Container is checked via the owner-scoped resolver BEFORE any step runs;
  not-yours and missing answer identically.
- Each id-bearing step re-reads the row and requires owner, card, home AND
  the row class the write may touch (plain line), then the exact expected
  quantity; any mismatch is one uniform refusal (no existence oracle).
- The insert-type step ("restore") carries only whitelisted scalar fields
  (quantity, date, slot), each re-validated server-side; it reuses the same
  put helper as the forward write, so it cannot set fields the forward write
  could not.
- A throw mid-loop rolls back the earlier steps (Convex mutation atomicity).

Gaps to look for in this shape:
- A step loop that re-reads per step (`take(MAX+1)` each) makes cost
  `steps x lines`; with a 200-step cap and 200 lines that is ~40k reads.
  Fails closed (own transaction errors) but read the set once and track it.
- Tests usually cover "other owner's container"; ask for the forged step that
  names ANOTHER owner's row id inside the caller's OWN container.

Armed migrations: the entry action gated confirm + env flag but its
`internalMutation` page took a bare `write: true` with no re-check. House
pattern (cardTeamLinks, cardCounts) re-checks the flag in the page mutation;
flag its absence as should-fix. Link [[neo304-armed-subtree-wipe]],
[[patterns-neo358-collector-rows-pin-catalog]].

Schema widening (new union literal written by a mount-time ensure mutation)
makes a plain revert undeployable once any user loads the page: a revert PR
must keep the schema additions. Call it out in the plan's rollback section.
