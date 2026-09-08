---
name: reference-neo92-entity-review-wizard
description: NEO-92 replaced UnknownEntitiesDialog (all-at-once checkbox list) with EntityReviewWizard (per-item review) — mechanics, aria-labels, and the setup-track SCALE BLOCKER (no bulk-confirm)
metadata:
  type: reference
---
> **STALE FLOW NAMES (2026-09-05).** Every `checklist-fetch-*` /
> `checklist-keyboard-only-dialog` flow named below was DELETED in NEO-220/221 —
> quick-add's Players field is a PlayerPicker, so a custom subtree can no longer
> produce an unknown name. The wizard mechanics here are still accurate; the flow
> names are history. See [[reference-neo220-wizard-only-from-real-fetch]].

NEO-92 replaced `UnknownEntitiesDialog.tsx` (one screen, ALL unknown names as
checkboxes, single "Confirm N & Save" / "Skip All & Save" button, uncheck=skip)
with `components/SetSelector/EntityReviewWizard.tsx` + `EntityLinkSearch.tsx`
(step-through, ONE unknown at a time). **Skip is GONE** — every name must resolve
to "Add as New" or "Link to Existing".

**Wizard surface (all Maestro-targetable):**
- Title text unchanged: `"Confirm New Players & Teams"` (dialog role, so any flow
  that only asserts the title still identifies it).
- Progress line: `"{decided} of {total} reviewed · {N} still being looked up"`.
- Per current item: visible text `"Add as New Player"` / `"Add as New Team"`
  (NeonButton, its own accessible name); link trigger visible text
  `"Link to Existing…"` (aria-label `"Link to existing instead"`).
- EntityLinkSearch: aria `"Search existing players"` / `"Search existing teams"`
  (both the listbox and the input); result buttons aria `"Link to {name}"`;
  collapse button aria `"Cancel linking"` (visible "Cancel (Esc)").
- Final step (only after EVERY item decided): text `"All reviewed — save N cards?"`
  + button `"Confirm & Save (Enter)"` (AUTO-FOCUSED via confirmButtonRef on the
  allDecided transition → `pressKey: Enter` commits, the old keyboard contract).
- Footer `"Cancel (Esc)"` present on EVERY step; onCancel → CardChecklist sets
  `"Fetch cancelled — no cards saved."` (cancelBatch mutation; still all-or-nothing).

**Reviewable-item gate = a live Wikidata round-trip.** `current` = earliest row
with `status !== "pending" && !decision`. Rows start pending; the background queue
(`processEntityReviewQueue`, `INTER_ENTITY_DELAY_MS=3000`) flips them ready/error
SERIALLY at 3s each. So "Add as New Player" only appears after that item's lookup
completes — wait on it with an EXTERNAL-fetch timeout (~30s), not the 7s UI budget.

**⚠ SCALE BLOCKER (raised, needs app decision):** the wizard has NO bulk "add all"
affordance. `setup.yaml` does a global RESET (wipes players) then fetches real sets
→ HUNDREDS of fresh unknowns, each gated 3s → draining them one-by-one is infeasible
(~17min of Wikidata for ~335 Base players + 335 taps). setup CANNOT go green (nor can
anything depending on it pre-confirming Base players) until a bulk "Add all remaining
as new" button exists. On WARM shared dev (real players already exist) the small
checklist flows see only their custom card's 1-2 unique unknowns → fine.

**~~Custom subtree short-circuits the wizard.~~ FIXED — DO NOT ACT ON THE OLD CLAIM.**
This memory used to say the wizard could ONLY be exercised on a REAL marketplace set
because `fetchCardChecklist` early-returned empty `unknownPlayers/unknownTeams` for any
custom subtree, and that "there is no per-worker-custom alternative". **That is no longer
true and must not be repeated.** Backend fix (2) proposed below WAS shipped: the
`isCustomSubtree` branch now calls `resolveUnknownsAndStartBatch`, so a custom subtree's
own custom cards' pendingPlayerNames DO surface and DO open the wizard.

VERIFIED IN SOURCE 2026-07-31 — `apps/web/convex/selectorOptions.ts:3820-3836`:
```ts
if (isCustomSubtree(chain)) {
  // ... skipping BSC/SL, but its own custom cards can still carry unresolved
  // pendingPlayerNames/pendingTeamNames — resolve those and open the review wizard
  const { unknownPlayers, unknownTeams, batchId } = sport
    ? await resolveUnknownsAndStartBatch(ctx, { selectorOptionId, sport })
    : { unknownPlayers: [], unknownTeams: [], batchId: undefined };
```

**So the wizard flows MUST use a per-worker custom set, not the shared real set.** Use a
custom `SET_NAME` under the REAL `Baseball / 2024 / Topps` ancestors (keeps
`sport="baseball"` → real roster available as link targets; a synthetic `E2E Test Sport N`
gives an empty roster). Proven green by three flows: `lce-N` (link-existing), `kod-N`
(keyboard-only), `fcd-N` (fetch-cancel) — 63/63 on run 30629527899.

Leaving the stale claim in place is what caused the NEO-106 incident: two flows kept
writing custom cards into shared "2024 Topps Chrome Base" and cross-contaminated other
runners' batches. See R7a in the agent definition and `apps/web/.maestro/SET-REGISTRY.md`.

**Custom cards never get playerIds on commit** (commitCardChecklist only clears their
pendingPlayerNames, never patches playerIds — selectorOptions.ts ~L4304). So "link vs
create" is NOT observable on the card. To prove "Link to Existing created no
duplicate": after commit, open a PlayerPicker and search the linked unknown name →
assert `id: "Create player <name>"` is PRESENT (that "+ Create" row renders only when
NO case-insensitive exact match exists — PlayerPicker.tsx hasExactMatch — so its
presence proves no entity was minted). PlayerPicker "+ Create" (players.findOrCreate)
persists the entity IMMEDIATELY on tap — use it to seed a deterministic link target.

**Backend deploy note:** NEO-92 backend (entityReviewQueue table+functions, changed
fetchCardChecklist/commitCardChecklist signatures) must be deployed to the target
Convex before ANY of these flows can run — the wizard query `entityReviewQueue.getBatch`
must exist and fetch must return `batchId`. Check with
`npx convex run entityReviewQueue:getBatch '{...}'` (function-not-found = not deployed).

**BULK-CONFIRM (added, unblocks setup):** `entityReviewQueue.recordAllRemainingAsCreate`
+ a footer button — visible text `Add All Remaining as New (N)`, aria `Add all
remaining as new (N)` — rendered whenever `!allDecided`. Marks EVERY not-yet-decided
row (incl. still-pending, no Wikidata wait) as create in one call → allDecided → final
step. Tap it (`text: ".*Add All Remaining as New.*"`) then Confirm. This is how
setup.yaml/signed-by fallback confirm hundreds of fresh unknowns, and how keyboard-only
reaches the final step robustly. Guard it with `when: visible` (absent once allDecided).

**PERSISTENT-BATCH DEBRIS (the local re-run trap):** entityReviewQueue batches AND
custom-card `pendingPlayerNames` PERSIST per `selectorOptionId` on the shared real set.
`startBatch` RESUMES an existing batch (doesn't add new rows). So a crashed/failed local
run leaves debris: leftover custom cards with unresolved pending names (re-surface as
unknowns every fetch) + a stale resumed batch (may show "all reviewed" immediately).
Symptoms: "Add as New Player" never appears (batch already decided); a prior attempt's
UnknownLink preempts the current one. FIXES: (1) re-run setup.yaml — its global reset
clears cardChecklist+players+entityReviewQueue → clean slate; (2) make flows batch-state
robust — cancel from ANY step, reach final via the bulk button, and for targeted-item
flows (link) add a PRE-CLEAN fetch that bulk-confirms pre-existing unknowns first so your
item is the SOLE unknown (also self-heals retries). Card #300 "300b" corruption was ALSO
debris (repeated re-syncs) — clean setup restores plain #300 (Julio Rodriguez) + #300b.
Note: commitCardChecklist schedules cleanupBatch ASYNC (runAfter 0), so a rapid re-fetch
can briefly resume the just-committed batch — a real race.

**CI-ONLY CANCEL FAILURE = SHARED-BATCH RE-RENDER DROPS THE TAP (RCA 2026-07-20, run 29796459345 r3).**
`checklist-fetch-cancel-dialog` failed CI-only: `notVisible "Confirm New Players & Teams"`
17s after the Cancel tap COMPLETED. NOT the "slow synchronous cancelBatch delete of a
large resumed batch" theory — REFUTED: failure screenshot showed the wizard stuck at
`0 of 0 reviewed / Looking up 0 more names…` (batch was EMPTY, a 3-row delete is ms).
Real mechanism: entityReviewQueue batches are keyed ONLY on `selectorOptionId` (NO
worker/attempt scoping) + `startBatch` RESUMES any existing batch → all concurrent CI
runners on the SAME real set (2024 Topps Chrome Base) SHARE ONE batch. ≥3 flows drive
that shared batch's lifecycle on that set: this cancel flow, `checklist-fetch-unknown-
entities-link-existing` and `checklist-keyboard-only-dialog` (both decide-all → Confirm
& Save → commit → cleanupBatch DELETES all rows). While runner-3's wizard was open,
another runner's commit drove the shared batch allDecided → deleted → runner-3's wizard
re-rendered from the 2-button footer (Cancel center-left + Confirm & Save) to the
1-button empty footer (Cancel alone, far right). PROOF: Maestro tapped Cancel at
`bounds=[395..505]` (center = 2-button state) but the failure screenshot has Cancel at
x≈598 (right = 1-button state) → the button MOVED between hierarchyBasedTap's coord
capture and the CDP click → the click hit empty dialog space → `handleCancel` never
fired → wizard never closed (banner still read the fetch msg, not "Fetch cancelled").
This is the NEO-81/85 maestro-web coordinate-staleness dropped tap, TRIGGERED by a
concurrent worker's DOM re-render. LATENT 2nd bug (not the cause here, cancelBatch is
idempotent+can't throw on empty): `handleCancel` puts `onCancel()` AFTER the try/finally,
so ANY cancelBatch rejection would also leave the wizard stuck open — move onCancel into
finally for robustness. Proper fix = scope batches per-attempt (schema change, deferred).

**LINK-EXISTING 3x CI FAIL RCA (2026-07-21, run 29800391941 r7) — GLOBAL NAME-SOURCE POOL, not the batch.**
`checklist-fetch-unknown-entities-link-existing` failed 3 CI runs straight: 30s assert
`.*UnknownLink-<attempt>.*` visible (the wizard's CURRENT step-through item) never true.
Screenshot PROOF: r7's wizard opened "0 of 3 reviewed" with FIRST item = `CDPlayerA-r5-a1-21592`
("No Wikidata match found" = lookup COMPLETED, NOT pending → refutes any rate-limit theory) —
a FOREIGN unknown from RUNNER 5's `checklist-fetch-cancel-dialog` (which adds CDPlayerA/CDPlayerB
custom cards to the SAME shared real 2024 Topps Chrome Base variant, then CANCELS → never clears
their pendingPlayerNames). The step-through wizard shows only the current item's name, so r7's own
UnknownLink (later in the 3-row batch) isn't visible → assert fails.
ROOT CAUSE = a GAP in the createdByUserId scoping effort, NOT a bug in entityReviewQueue.ts (that
code is correct: startBatch keys (selectorOptionId,createdByUserId); getBatch reads only batchId).
The wizard's item list is SEEDED from a still-GLOBAL source: fetchCardChecklist's custom-card
pending-name pass (selectorOptions.ts ~L3768-3775) reads getCardChecklist({selectorOptionId}) =
ALL custom cards on the shared variant across EVERY user/runner, folding their pendingPlayerNames
into the CURRENT caller's batch via startBatch. So a per-user batch gets cross-user names injected
AT CREATION. cardChecklist has NO per-user field (addCustomCard stamps isCustom only, no
createdByUserId) → backend can't scope this pass without a SCHEMA change.
NO CLEAN FLOW-LEVEL FIX: the Step-1 pre-clean is a TOCTOU race (another runner adds its custom card
between pre-clean-commit and Step-3 fetch); driving past foreign items would require "Add as New" on
another runner's names → pollutes the GLOBAL players table + breaks cancel-dialog. Per-worker custom
subtree is BLOCKED (isCustomSubtree short-circuit, L3378, returns empty unknowns). Two candidate
BACKEND fixes, each a product-semantics call (→ owner decides): (1) scope the custom-card pending-name
pass to the caller's own custom cards (needs cardChecklist.addedByUserId schema+stamp+filter) — but
may be a prod regression (shared catalog: admin B should arguably still get prompted for admin A's
custom-card player); (2) drop the isCustomSubtree short-circuit for the pending-name pass so custom
subtrees ALSO surface their own pending names + open the wizard → gives each runner a PRIVATE custom
subtree to test on (true isolation). Reported to owner 2026-07-21; did NOT patch.

**RESOLVED — fix (2) WAS SHIPPED (verified in source 2026-07-31).** The isCustomSubtree
short-circuit no longer blocks the pending-name pass; `selectorOptions.ts:3820-3836` calls
`resolveUnknownsAndStartBatch`. Every runner CAN have a private custom subtree, so the
"NO CLEAN FLOW-LEVEL FIX" verdict above is obsolete — **the clean fix is a per-worker
custom set, and it is now mandatory (R7a)**.

COST OF NOT UPDATING THIS SOONER: `checklist-fetch-cancel-dialog` and
`checklist-keyboard-only-dialog` stayed on the shared real set, kept injecting custom
cards into it every attempt, and cross-contaminated each other — CI run 30505189226,
runner 4's CDPlayerA/CDPlayerB leaked into runner 2's batch (3 unknowns instead of 1).
Both migrated to `fcd-N` / `kod-N` in PR #110; suite went 62✓/1✗ → 63✓/0✗.
The shared 2024 Topps Chrome set now has exactly ONE writer: setup.yaml.

**VALIDATION (2026-07-20, local vs the shared dev deployment):** setup ✓ (bulk button drives Base
~335 + Insert + Parallel ~300 fresh unknowns), cancel ✓, keyboard-only ✓, link-existing ✓
(clean first-attempt after a fresh setup). signed-by ✗ — NOT a NEO-92 issue: the
Autographed control was redesigned `<select id="Value for Autographed">` → "On Card"/
"Sticker" toggle pills in the UNCOMMITTED in-flight FeatureValueControl.tsx (NEO-71-74);
signed-by drives the old select. My only signed-by edit (wizard bulk-confirm fallback) is
correct + skipped on warm Base. Its Autographed interaction needs updating alongside the
NEO-71-74 control redesign (toggle-pill aria `Value for Autographed: On Card` etc.).

**MIGRATION (2026-07-21) — link-existing flow off shared real Base onto private per-worker custom set (backend now opens wizard on custom subtrees):**
`convex/selectorOptions.ts` new shared `resolveUnknownsAndStartBatch`; the
`isCustomSubtree` branch of fetchCardChecklist now calls it, so a custom subtree's
OWN custom-cards' `pendingPlayerNames` open the wizard (previously returned no
unknowns). This lets a wizard flow run on a PRIVATE per-worker `selectorOptionId`
(`getCardChecklist({selectorOptionId})` is still GLOBAL across authors, so only a
private node eliminates cross-runner contamination at the SOURCE — batch scoping
alone doesn't). `checklist-fetch-unknown-entities-link-existing.yaml` migrated:
drills `util-drill-to-custom` Baseball/2024/Topps + custom Set `lce-${WORKER_INDEX}`
/Insert/Base. KEY INSIGHT: a custom SET under REAL Baseball → `isCustomSubtree`
(BSC/SL skipped) BUT `sport="baseball"` (line ~3459 lowercases the real sport
ancestor) → the wizard's EntityLinkSearch `players.list({sport:"baseball"})` lists
the REAL setup-synced roster → **link to Ohtani works verbatim, zero change to the
link step**. A fully-synthetic "E2E Test Sport N" gives an empty roster; and
seeding a target via PlayerPicker "+ Create" is CASING-BROKEN (findOrCreate uses
raw `ancestorSport="Baseball"` → primarySport="Baseball", invisible to the wizard's
lowercased "baseball" query). Ohtani is the only correct target. Deleted the whole
shared-Base pre-clean. Green locally 3m16s→3m38s (both attempts).
RETRY-DEBRIS SELF-HEAL (added, CLOSED): `ATTEMPT_ID=w<n>-a<attempt>-<RANDOM>` is
unique per RETRY + setup-reset runs once/CI-run, so a mid-flow failure BETWEEN
wizard-open and commit would leave this worker's own debris pending-name → a retry's
fresh name sits BEHIND it (wizard shows earliest-inserted undecided item only). Fix =
a PRIVATE Step-1 fetch-and-bulk-confirm-if-wizard-opens pass on THIS worker's own
subtree BEFORE adding the attempt's card (mirrors the old shared pre-clean shape, now
safe/cheap since private). On attempt-1 the subtree is empty → Sync = empty-state
"Fetch from Marketplaces" (aria still "Sync card checklist"; exactly one Sync button
renders — empty-state XOR header "Refresh") → commits "Saved 0 cards", no wizard.
Sibling `checklist-fetch-cancel-dialog`
+ `checklist-keyboard-only-dialog` are NOT fragile to this class: neither asserts
its own unique name is the current/sole wizard item (cancel just asserts the wizard
OPENED then cancels from any state; keyboard bulk-"Add All Remaining as New" sweeps
ALL items incl. foreign contamination into one commit) — contamination-tolerant, no
migration needed. They still WRITE per-attempt cards to the shared real Base variant
(mutual/topps-chrome contention), but that's doc-contention, not the sole-item class.
