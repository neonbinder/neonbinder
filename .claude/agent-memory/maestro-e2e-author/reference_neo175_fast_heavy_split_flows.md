---
name: neo175-fast-heavy-split-flows
description: NEO-175 preprocess fast/heavy split — the two placeholder E2E flows, the EXACT cold-start notice text (it says "full"), the heavyWarming/escalating-badge timing, and how to validate fixture routing locally with fast_tiered_crop
metadata:
  type: reference
---

# NEO-175 preprocess fast/heavy split — placeholder E2E

Extends [[neo170-placeholder-pipeline-page]]. Phase 4 split the ONE placeholder
pipeline flow into two, one per user case.

## The split (what a card does)
- Images hit a FAST classical Cloud Run service first (`PREPROCESS_ROLE=fast`,
  `escalate_only`). A card that FILLS the frame is accepted as a "frame" identity
  (`fast_tiered_crop` → returns input) → stays fast (~1-2s, NO model).
- A card INSET on a scanner bed is DECLINED (`fast_tiered_crop` → None →
  `CropDeclined`) → Convex marks the row `escalated`, schedules the HEAVY pool +
  a ONE-instance heavy warm-up. Heavy = full BiRefNet, cold-loads ~191s.
- Heavy parallelism dev/preview = **3** (`HEAVY_PREPROCESS_MAX_PARALLELISM` unset
  → default 3). So 6 escalations ≈ cold-load(~191s) + ~2 warm waves → **~260s**,
  inside a 5-min budget. The heavy warm-gate warms only ONE instance (avoids
  stampeding N cold heavy instances), so wave-1 siblings still cold-start.

## THE cold-start notice — EXACT text (it says "full")
`app/placeholders/page.tsx` renders, when `job.heavyWarming`:
> **"Warming up the full card processor — some scans need deeper analysis, which can take a couple of minutes the first time. The rest keep coming in below."**
- The task sketch called it "Warming up the card processor" (NO "full") — WRONG.
  Match the real text. Robust regex used in both flows:
  `.*[Ww]arming up the .*card processor.*` (the `.*` between "the" and "card"
  eats "full " and also matches copy without it). Full-anchored + DOT_MATCHES_ALL,
  so leading/trailing `.*` cover the rest of the sentence; the aria-hidden pulse
  `<span>` has no text so the `<p>`'s node text is just the sentence.
- `heavyWarming` (`deriveHeavyWarming`) is true iff **some image is escalated AND
  no escalated image has resolved yet**. It flips FALSE the instant the FIRST
  heavy result lands. So the notice is up for the WHOLE ~191s cold load — easy to
  catch, no race — then vanishes (removing ~70px above the status line).
- Per-image badge (`imageSummary`, status `processing`+`escalated`):
  **"Escalating — deeper processing…"** → match `.*Escalating.*deeper processing.*`.
  While `heavyWarming` is true, ALL escalated rows are still processing → all
  badged, so it's reliably assertable right after catching the notice.

## Fixture routing IS locally validatable (no network, no deploy)
The fast/heavy decision is pure classical CV — validate it in the preprocess venv:
```
PYTHONPATH=services/preprocess services/preprocess/.venv/bin/python3 -c "
from app.cropper.tiered import fast_tiered_crop
# returns bytes = ACCEPT (fast, 'frame' identity); None = ESCALATE (heavy)"
```
Confirmed: the committed INSET set (`public/placeholder-fixtures/`) → all 6 None
(escalate); the FULL-BLEED set (`public/placeholder-fixtures-fullbleed/`) → all 6
bytes (accept, log "fast: identity (frame-fill card-aspect frame)"). The
downstream `_try_stage`/OCR gate needs Vision (network) — NOT locally checkable —
but the ESCALATION ROUTING (the thing NEO-175 tests) is fully local.
- Fast accept requires: image aspect within 0.03 of 2.5:3.5 (1000×1400 IS card
  aspect ✓) AND `should_identity` returns `(True,"frame")` = the top classical
  component's rect fills **≥92%** of the frame. Full-bleed recipe that reliably
  hits it: thin distinct **border ring** (18px) + a large interior fill (≥92%),
  and NO big contrasting interior block on the front (a photo block reads as a
  smaller card-aspect object → "margin"/escalate). Generator `--full-bleed` mode.

## The two flows (apps/web/.maestro/flows/placeholders/)
CURRENT as of the 2026-08-21 rewrite for PR #180's E2E gate (measured against the
dev preview via direct `/process-entry` probes — trust these over the old draft):
- MEASURED timings: warm fast `/process-entry` = **4.1s**, fast cold-start ~**22s**;
  warm heavy = **124s**, COLD heavy = ~**191s model load + ~124s inference ≈ 315s**
  per image (heavy is CPU-bound — GPU is NEO-173, quota-blocked). The old shared
  240s adapter timeout caused a retry-storm (6-image heavy batches = 32-42 MIN).
  Convex fix on the neo-170 branch / #180: **split the timeout (fast 60s / heavy
  400s), heavy retries 5→3, pre-warm heavy UPFRONT at batch start** (its ~191s load
  now overlaps the fast phase). The `heavyWarming` "Warming up…" notice still fires
  on the first escalation exactly as before.
- `pipeline-pairs-uploaded-scans.yaml` (FAST): entry adds
  `redirect=/testing/seed-placeholder-upload%3Ffixtures%3Dplaceholder-fixtures-fullbleed`.
  Completion wait is `.*6 of 6 images processed, 0 failed.*` **120000ms** (NO pair
  count — see next bullet; 120s absorbs a COLD-preview burst: fast cold-starts +
  queue contention). Then `assertNotVisible` the notice (load-bearing fast-path
  guard), Close→`.*Succeeded.*6 of 6 … 0 failed.*` (15s), `resolver calls: 6`.
- **The fast crop drops the pair COUNT** (do NOT re-add it): on the FAST classical
  crop the synthetic full-bleed FRONT of one fixture pair (Marcus VORKLE)
  deterministically side-classifies as "back" (`/process-entry`: needs_escalation
  false, side "back") → only 2 pairs form, not 3. Synthetic-fixture artifact (real
  fronts have a photo → classify reliably), NOT a product bug. Pair count is owned
  by `convex/lib/pairing/*.test.ts` + proven E2E on the HEAVY crop by FLOW 2. FAST
  asserts only the deterministic outcome: 6/6, 0 failed, no notice, resolver 6.
- `pipeline-escalation-cold-start.yaml` (HEAVY): now uses the **2-image / 1-pair**
  set `placeholder-fixtures-escalation-pair` (ONE inset pair, Marcus QUILLDEN
  `03-quillden-front.jpg`+`04-quillden-back.jpg`, manifest pairCount 1; allowlisted
  in seed-placeholder-upload/page.tsx). Entry adds
  `%3Ffixtures%3Dplaceholder-fixtures-escalation-pair`. Shrunk from 6 images because
  an all-heavy CPU batch (~124s/img + ~191s cold load) blows past the ~5-min bar; a
  single pair (~315s) lands near it while still proving the whole story. Precondition
  `.*of 2 images processed.*` → `scrollUntilVisible ".*resolver calls.*"` → wait
  notice **120000ms** → `scrollUntilVisible` Escalating badge (scroll IS the assert)
  → `scrollUntilVisible direction: UP ".*of 2 images processed.*"` → wait
  `.*2 of 2 images processed, 0 failed, 1 pair.*` **480000ms** (the ONE sanctioned
  multi-minute wait; legit ONLY because the notice + per-image badge cover every
  second with visible progress — the user's hard requirement). Both tagged
  `placeholders, regression`.
- **Status line ALWAYS pluralizes** (`${pairCount} pairs` in page.tsx:183 — renders
  "1 pairs" for one pair), so the heavy assert's `…1 pair.*` matches via the trailing
  `.*`; the count is still exact.

## Seed page now takes `?fixtures=` (allowlisted)
`seed-placeholder-upload/page.tsx`: `?fixtures=` selects the set dir (default
`placeholder-fixtures`; allowlist also has `placeholder-fixtures-fullbleed`).
Nested query is passed through sign-in's `redirect` param URL-encoded
(`%3F`/`%3D`), the same pattern the page's own `?redirect=…%3FjobId%3D…` uses.

## Can't run these locally — by design
Dev (the shared dev deployment) has NEITHER the split NOR the base STREAM/workpool
functions (`command npx convex function-spec` on dev returns none of
`startPlaceholderStream`/`placeholderHeavyPool:*`/`warmupHeavyPreprocess`). So a
local `test:e2e:pick` hits the wrong backend and can't reach Step 2. These flows
are authored for the PR's Convex-preview E2E gate. Don't burn the run lock trying.
