---
name: neo175-fast-heavy-split-flows
description: Placeholder pipeline fast/heavy split (NEO-175, NEO-152 copy, NEO-299 six-image heavy flow) — the two pipeline flows, the EXACT cold-start notice and status copy, heavyWarming/escalating-badge timing, why the heavy flow runs six photos past the cap, and how to validate fixture routing locally with fast_tiered_crop
metadata:
  type: reference
---

# Placeholder pipeline fast/heavy split — placeholder E2E

Extends [[neo170-placeholder-pipeline-page]]. NEO-175 split the placeholder
pipeline flow into two, one per user case. NEO-152 rewrote every line of copy
they assert. NEO-299 grew the heavy flow from one pair to six photos.

## The split (what a card does)
- Images hit a FAST classical Cloud Run service first (`PREPROCESS_ROLE=fast`,
  `escalate_only`). A card that FILLS the frame is accepted as a "frame" identity
  (`fast_tiered_crop` → returns input) → stays fast (~1-2s, NO model).
- A card INSET on a scanner bed is DECLINED (`fast_tiered_crop` → None) → Convex
  sets `escalated: true` on the row (status stays `processing`) and enqueues it on
  the HEAVY pool. Heavy = full BiRefNet, cold-loads ~191s, ~124s CPU inference per
  image (GPU is NEO-173).
- Capacity is ONE number per environment since NEO-299:
  `apps/web/convex/preprocessCapacity.json` (heavy/fast × prod/dev/preview), equal
  to BOTH the pool's `maxParallelism` and the Cloud Run max instances, parity-checked
  in CI. A PR preview's heavy cap is small (read the JSON; it was 3 at NEO-299).
- Heavy warm-ups go THROUGH the heavy pool (share its slots, fan out to the cap),
  fired at stream open (`warmupPreprocess`) and again at the first escalation. So
  the cold load overlaps the fast phase and warm-ups never 429 the escalations.
- Heavy retry ladder since NEO-299: 5 attempts, 40s base, ×2, jitter 0.5-1.5 —
  sized so a 429 during a cold load cannot burn every attempt (the old 3 × 5s/10s
  ladder could, and failed photos "couldn't be read").

## THE copy — EXACT text (NEO-152, `app/print/placeholders/intake.tsx`)
- Cold-start notice, shown while `warmingUp`/`heavyWarming`:
  > "A few of these need a closer look, which takes a couple of minutes the first time. The rest keep coming in below."
  Match `.*A few of these need a closer look.*` — text selectors are a FULL match
  and the `<p>` carries the second sentence. The old "Warming up the full card
  processor…" string no longer exists anywhere; a flow waiting on it times out
  with the notice on screen the whole time.
- Status line by stage: "Getting your photos ready…" → "Reading your cards — N of
  M done." → **"All M photos read."** (stage `waiting`) → "Matching up the last
  pairs…" → **"N pairs ready to print."** (stage `done`).
- **Pluralisation is CORRECT now**: `pair${n === 1 ? "" : "s"}` → "1 pair ready to
  print.", "3 pairs ready to print." Assert the exact string; the old "1 pairs"
  workaround (a trailing `.*`) is obsolete.
- "All M photos read." means every row SETTLED, and a FAILED row counts as settled.
  It is a completion wait, never a zero-failures proof. The pair count is: pairing
  reads only `status === "done"` rows (`placeholderPairing.ts`), so N/2 pairs from
  N photos proves all N were read.
- Failed photos show as a `<details>` summary "K photo(s) couldn't be read" at the
  very BOTTOM of the session panel (below review grid + print run). The hierarchy is
  viewport-clipped and nothing stable sits below it, so an `assertNotVisible` on it
  passes whether or not it exists — do not write one; use the pair arithmetic.
- `heavyWarming` is true iff some image is escalated AND no escalated image has
  resolved; it flips false at the FIRST heavy result. The notice renders BELOW the
  status box (not above the status line), so its disappearance does not move the
  status line.
- Per-image badge in the "Still reading (N)" list: "Escalating — deeper
  processing…" → `.*Escalating.*deeper processing.*`. While `heavyWarming` holds,
  every escalated row is badged.
- Close: "Finish the batch" (stage `waiting`; "Finish now" while working) →
  dialog "Finish this batch?" → "Finish it". ≤100 images finalize INLINE in the
  close mutation, so the done copy is an in-app response (7s bar).

## Fixture routing IS locally validatable (no network, no deploy)
The fast/heavy decision is pure classical CV. `services/preprocess/.venv` may not
exist (torch has no arm64 macOS wheel), but `app/cropper/tiered.py` imports only
cv2/numpy/PIL: a scratch venv with the service's PINNED
`opencv-python-headless`, `numpy`, `Pillow` from `requirements.txt` is enough. Load
the module by FILE PATH (`importlib.util.spec_from_file_location`) — importing
`app.cropper` runs its `__init__`, which pulls the full classify/SAM stack.
`fast_tiered_crop(bytes)` → bytes = FAST ACCEPT; None = ESCALATE.
Confirmed (re-checked 2026-09-24): inset `public/placeholder-fixtures/` → all 6
None; full-bleed `public/placeholder-fixtures-fullbleed/` → all 6 accepted. The
OCR/side stage needs Vision (network) — NOT locally checkable.
- Fast accept requires card aspect (1000×1400 ✓) AND `should_identity` → "frame"
  (top component fills ≥92% of the frame). Generator `--full-bleed` mode.

## The flows (apps/web/.maestro/flows/placeholders/)
- `pipeline-pairs-uploaded-scans.yaml` (FAST, full-bleed set): "All 6 photos
  read." → `assertNotVisible` the notice (fast-path guard) → finish → "2 pairs
  ready to print." + "Not paired (2)". **Two pairs, not three, by design:** on the
  FAST crop the synthetic full-bleed VORKLE front side-classifies as "back".
  `flip-edge-mirrors-the-backs.yaml` also uses the full-bleed set.
- `pipeline-escalation-cold-start.yaml` (HEAVY, default inset set, SIX photos
  since NEO-299): notice → Escalating badge → "All 6 photos read." → finish →
  "3 pairs ready to print.". Six escalations against the preview heavy cap force
  two inference rounds through a cold load — the smallest batch that exceeds the
  cap, which is what the NEO-299 proof needed; the old one-pair version never
  exceeded it. The heavy completion wait carries a Jason-approved budget recorded
  at the site with its arithmetic (cold load + rounds × inference + fast phase +
  margin); a different cap or fixture count voids it — recompute and re-approve,
  never just raise it.
- The one-pair `placeholder-fixtures-escalation-pair` set was retired in NEO-299.
  The seed page allowlist is now `placeholder-fixtures` (default) and
  `placeholder-fixtures-fullbleed`.

## Seed page takes `?fixtures=` (allowlisted)
`app/testing/seed-placeholder-upload/page.tsx`: `?fixtures=` selects the set dir;
an unknown value falls back to the default. Nested query goes through sign-in's
`redirect` param URL-encoded (`%3Ffixtures%3D…`).

## Local runs need the PR's own preview
These flows exercise Convex pipeline code and the PR's preprocess revisions, so a
local run against a deployment without the branch's functions cannot reach the
pipeline. Run them against the PR's own Convex preview (after push), or let CI
be the proof.
