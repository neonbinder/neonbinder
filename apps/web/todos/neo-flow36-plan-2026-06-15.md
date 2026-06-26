# Flow #36 — `set-selector/topps-chrome-marketplace-read` — Walk Plan (2026-06-15)

The **read-only twin of #35** — verifies the marketplace sync produced feature data on the real
2024 Topps Chrome set, without any writes.

## R1 — Feature
Read-only smoke: drill to real Topps Chrome → open `SetAttributesPanel` → assert (1) breadcrumb scope
(`.*›.*Topps Chrome.*`), (2) the **"Will propagate to N cards"** counter, (3) the setMetadata section
renders (TCDB chips OR the empty state), (4) a **"Value for League"** feature row exists. No taps that mutate.

## Per-rule verdict
| Rule | Status | Notes |
|---|---|---|
| R1 feature | ✅ | clear, single read-only feature |
| R2 assert-only | ✅ | idempotent-expand guarded by `assertVisible id:"Hide attributes"` |
| **R3 dedup** | 🟡 **PROPOSE** | unique *coverage* (sync-produced-data presence — #35 doesn't assert the propagate counter / metadata section), but its **~120-line Topps Chrome drill duplicates #35's + the existing `util-drill-to-2024-topps-chrome`** → see proposal below |
| **R4 / tag** | 🟡 **cleanup** | stale "isolated serial lane / Phase 1 before Phase 2" comment → replace with read-only-no-contention rationale; name "(isolated)" → "(read-only)"; add `set-selector` tag |
| **R5 waits** | 🟡 **cleanup** | trim 4 column-heading `20000`→7s (Years 67, Manufacturers 88, Sets 109, Variant Types 130); KEEP 60s/30s search-syncs + 45s sign-in + 20s "Set Selector" page waits |
| **R6 redundant** | 🟡 **cleanup** | lines 200-207: `scrollUntilVisible id:"Value for League"` then `assertVisible id:"Value for League"` (same element) → drop the `assertVisible` (the scroll already asserts visibility) |
| R7 destructive | ✅ | **explicitly read-only** — a feature/guard (never taps save/Edit/inputs). Worth keeping as the no-mutation regression guard. |
| R8 centerElement | ✅ | the League scroll is a read assert (scroll itself reaches a below-fold row); centerElement only matters for taps. Optional to add for consistency. |

## R3 dedup proposal (propose-and-wait — touches #35 too)
`util-drill-to-2024-topps-chrome.yaml` exists as a thin wrapper (defaults Baseball/2024/Topps/Topps Chrome,
navigates itself, **returns at the Variant Types column with the setName selected** = exactly the state both
flows need before opening the panel). **Only #35 and #36 still hand-roll this drill** (every other flow already
delegates). Proposal: **replace the inline ~120-line drill in BOTH #36 and #35 with `runFlow util-drill-to-2024-topps-chrome`**
(no env needed — defaults match). #35 does it twice (initial + persistence re-drill), #36 once. Removes ~240
duplicated lines and centralizes the drill (so the next drill fix lands in one place).
- **Trade-off:** #35 was just cleaned without this, so accepting means one more small edit to #35 (swap its two
  inline drills for the `runFlow`) + re-validate it.
- **If declined:** keep the inline drills; #36 still gets the R4/R5/R6 cleanup. The duplication just persists.

## Decision
- **Single-path cleanup (do regardless):** R4 (rewrite stale lane comment + name + `set-selector` tag),
  R5 (4 column-heading waits → 7s), R6 (drop the redundant League assert).
- **R3 dedup (your call):** replace the inline Topps Chrome drill with `runFlow util-drill-to-2024-topps-chrome`
  in #36 **and** #35. Recommend **yes** — it's the exact "reuse shared logic" R3 case, and these are the last
  two stragglers. But it re-opens the just-validated #35, so I'll only do it if you greenlight.

## After the decision
1. maestro-e2e-author applies the cleanup (+ dedup if approved, to both flows).
2. Validate: enqueue #36 alone (read-only → safe; if dedup approved, re-enqueue #35 too).
3. Update tracker: mark #36 walked + GREEN; note the dedup outcome.
