# Flow #35 — `set-selector/topps-chrome-add-feature` — Walk Plan (2026-06-15)

**The flow that carries the cross-cutting decision: "shared-set write isolation under the queue."**
This is the ONE sanctioned feature-WRITE on the REAL 2024 Topps Chrome set.

## R1 — Feature
Write a feature value ("League" = `TChrome-MLB`) on the real 2024 Topps Chrome set via
`SetAttributesPanel`; verify the **"Updated N cards" propagation toast** fires, then reload + re-drill
and confirm the value **persists** in the "Value for League" input.

## ⚖️ The cross-cutting decision — shared-set write under the NEO-49 queue
The flow's header still says *"Isolated serial lane prevents concurrent mutations"* — but **the queue
removed lanes** (every flow runs on whatever runner claims it; there is no `isolated` tag, and none can
bring lanes back). So the stale lane story must be replaced with a real isolation story. Resolution:

**→ Idempotent-write tolerance (sole-writer).** Confirmed safe under the queue because:
- **#35 is the ONLY flow that writes Topps Chrome's `League` feature.** #36 (`topps-chrome-marketplace-read`)
  is read-only and only checks that a "Value for League" row *exists* (#35's write satisfies, not breaks, it).
  #27 (`features-propagation`) writes a *per-worker custom* set, not Topps Chrome. #22 reads Base card
  badges, not `League`. → **no concurrent contender on this datum.**
- Only **one** `#35` row is enqueued per run → it never races itself.
- It writes a **fixed** value (`TChrome-MLB`) via a two-step (CLEAR→MLB) that guarantees its own write is a
  real change → deterministic toast, convergent end-state.
⇒ Keep the write; **delete the stale "isolated serial lane / Phase 1 before Phase 2 reset" comment** and
replace it with the sole-writer/idempotent rationale. (No per-worker subtree possible — the BSC-backed
feature panel only exists on the real marketplace set.)

## Per-rule verdict
| Rule | Status | Notes |
|---|---|---|
| R1 feature | ✅ | clear single feature (feature-write + propagation + persistence) |
| R2 assert-only | ✅ | idempotent-expand guarded by `assertVisible id:"Hide attributes"`; persistence asserted on `.*TChrome-MLB.*` |
| R3 dedup | ✅ | unique — sole feature-WRITE-to-real-Topps-Chrome + propagation-toast test |
| **R4 / tag** | 🟡 | **stale "isolated serial lane" comment** — replace per the decision above |
| **R5 waits** | 🟡 **cleanup** | see below |
| **R6 redundant** | 🟡 **cleanup** | see below |
| R7 destructive | ⚠️ note | NOT destructive, but the ONE sanctioned **shared-set mutation** — flag explicitly so reviewers don't trip on it. Benign to other flows (writes a feature no other flow asserts a specific value for). |
| R8 centerElement | ✅ | the `Value for League` scrolls already use `centerElement:true`; drill uses search-then-tap (target near top, not below fold) |
| +9 tags | 🟡 | tagged only `regression`; consider adding `set-selector` for grouping consistency |

## Cleanup findings
1. **R6 — drop the redundant assert.** Lines 173-183: `scrollUntilVisible id:"Value for League" centerElement`
   immediately followed by `extendedWaitUntil visible: id:"Value for League" timeout:5000` → the scroll
   already asserts visibility; drop the `extendedWaitUntil`. (The verify-section scroll at ~318 is followed
   by `assertVisible ".*TChrome-MLB.*"` — a *different* assertion, NOT redundant; keep.)
2. **R5 — trim pure column-heading waits to 7s.** The `"Years"/"Manufacturers"/"Sets"/"Variant Types"`
   heading `timeout: 20000` waits (lines 64/85/106/127/292) are UI column-mounts → 7s. **KEEP** the 60s
   `Search years`/`Search sets` and 30s `Search manufacturers` waits (real aggregator marketplace sync) and
   the 45s sign-in wait.
3. **KEEP the two 30s "Updated N cards" propagation waits (lines 195-198, 208-211)** — a synchronous bulk
   propagation to 200-500 real Topps Chrome cards is the sanctioned bulk-write carve-out (same class as the
   335-card commit in #5). Comment it as such so it isn't re-flagged.
4. **R4/tag:** replace the stale lane comment (decision above); optionally add the `set-selector` tag.

## Prerequisite / validation note
#35 reads the **pre-synced Topps Chrome** (variant types + 200-500 cards) — the local harness doesn't run
the setup track, but **setup was rerun** so Topps Chrome exists on dev. Validate by enqueuing **#35 alone**
(so the other worker is idle → no Topps Chrome contention). If the propagation toast doesn't fire or shows
"Updated 0", that's an evidence-first finding (the set has no cards / the write was a no-op), not a pad.

## Decision (single path)
**Cleanup + re-document the isolation story:** R6 drop the redundant League assert, R5 trim the 4 column-
heading waits → 7s (keep the search-syncs / 30s propagation / 45s sign-in), replace the stale "isolated
serial lane" comment with the sole-writer/idempotent rationale, add the `set-selector` tag. Route through
`maestro-e2e-author` (edit-only); validate by enqueuing #35 alone on the harness.
