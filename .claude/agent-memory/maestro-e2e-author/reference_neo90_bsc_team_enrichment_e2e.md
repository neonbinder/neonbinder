---
name: neo90-bsc-team-enrichment-e2e
description: BSC per-card team enrichment E2E — POST-NEO-195 the background queue is UNREACHABLE from E2E (in-fetch lookup + ABSORB fix beat it); what the flow really covers, ground-truth teams, reachability, live-data diagnosis moves
metadata:
  type: reference
---
Flow: `.maestro/flows/set-selector/checklist-bsc-team-enrichment.yaml` (tags: set-selector, regression).

## CORRECTED 2026-08-30 — the background queue is NOT what this flow walks any more
This file used to say the flow proves the NEO-90 BACKGROUND queue
(`processBscTeamEnrichmentQueue` → `resolveBscCardTeam` → `applyBscTeamResolution`,
scheduled by `commitCardChecklist` for cards committed with no team). **That is
no longer true and the flow header was rewritten to stop claiming it.**

NEO-195 (commit `017f718`, PR #205) moved the per-card BSC team lookup INTO the
fetch — `fetchCardChecklist` step 4 in `convex/selectorOptions.ts`:
`needsTeamLookup = out.filter(c => !c.teams?.length && !c.team && c.platformData.bsc)`,
looked up in chunks of 50 via `fetchBscCardTeamNames` — and fixed
`CardPairingModal`'s append-only ABSORB reducer, which had been discarding every
team the fetch resolved. Now the team reaches the modal, rides Confirm into
`commitCardChecklist` as a team link, and the commit never enqueues that card.

**Why NO E2E flow can reach the background queue any more** (checked against the
code, not guessed):
- Enqueue requires `platformData.bsc` AND empty `teamOnCardIds` at commit.
  The in-fetch pass already tried every such card against the SAME endpoint
  (`fetchBscCardTeamNameRaw`, `/marketplace/card/{id}/card-listing`), so the
  leftovers are cards BSC has no team on file for — nothing to assert — plus
  transient-failure retries, which are timing, not structure.
- SL-only cards (no BSC ref) are skipped by BOTH the in-fetch pass and the
  enqueue, so they are not a way in either.
- Reaching it deliberately needs a fresh fetch+commit = a WRITE. R7a forces
  writes onto a per-worker custom subtree, and a custom subtree skips BSC
  entirely (NEO-22) → no BSC ref to enrich. Writing the real Topps Chrome set
  is banned. Dead end both ways.
- Queue logic is unit-covered instead: `convex/bscTeamEnrichmentQueue.test.ts`
  (+ `.tolerance.test.ts`). In-fetch lookup: `convex/fetchCardChecklistTeamLookup.test.ts`.
  The ABSORB merge: "a team resolved mid-session reaches onConfirm" in
  `components/SetSelector/CardPairingModal.test.tsx`.

**What the flow honestly covers now:** the END STATE — an ordinary single-player
BSC Base card carries its real team when an operator opens the detail drawer. It
cannot distinguish the two mechanisms (same endpoint; setup finished minutes
earlier so either path has landed). Consequently the old 60s "R5 marketplace
exception" on the team chip is gone — the team is in the DB before the flow
starts, so it is a plain 7s-default `assertVisible`.

Still true from NEO-90: cards WITH a team from the cheap synchronous
`parsePlayersField` parse (TC-suffix / League-Leaders / parenthetical inserts)
never need a lookup at all. So an ORDINARY single-player card is still the right
target — it is the one that actually exercises the per-card BSC lookup.

## The flow is READ-ONLY on the shared real set (no per-worker subtree needed)
Reads the shared, global 2024 Topps Chrome Base checklist that setup.yaml
pre-syncs, opens the target card's CardDetailPanel drawer, asserts the Teams
chip, and CANCELS (never Saves). Reads don't collide with concurrent workers, so
a shared-real-set READ is data-isolation-safe without a per-worker custom
subtree. (Only WRITES to a shared real set are banned.) `isolated` lane is dead —
safety here is being read-only, not a lane.

## UI surface: the resolved team = a TeamPicker chip in the drawer
Drawer "Teams" section (position 2, top of body, no scroll). A resolved team
renders as chip `aria-label="Remove team <name>"` (also a span `Team: <name>`).
Assert `id: "Remove team Seattle Mariners"`. Chip may flash `Loading…` while the
team id→name query resolves — waiting on the exact name covers that.

## Ground truth (verified live, unauthenticated, 2026-07) for 2024 Topps Chrome Base
- #1  Shohei Ohtani    bsc=2bd390ca7f1628153326e18e9c3b68e8 → "Los Angeles Dodgers"
- #2  Colt Keith       bsc=2ecaaba7edb6e478776bd589227f8a54 → "Detroit Tigers"
- #300 Julio Rodriguez bsc=e37718c040123c15fba3b8d3aa83a752 → "Seattle Mariners"
Fixed-team assertion is legit (immutable printed set). Get bscCardId from shared
dev: `npx convex data cardChecklist --limit 5000 --format jsonl` then filter
`features.season=='2024' and 'Topps Chrome' in listingTitle` (NOTE the title is
"2024 Topps Topps Chrome …", NOT "2024 Topps Chrome" — don't grep that substring).

## Reachability: card #1 (top) is UNREACHABLE after the drill; #300 (bottom) works
After `util-drill-to-base-variant`, react-virtuoso is NOT at index 0 and
`scrollUntilVisible` DOWN walks to the BOTTOM (#295–#300b) — `Edit card 1` never
appears (15s+ timeout). #300 (plain base, second-to-last row, Edit at y≈428,
inside the fold) IS reliably reached with DOWN scroll, `visibilityPercentage: 50`,
NO centerElement (bottom-region centering loops forever),
`waitToSettleTimeoutMs: 1000`, `timeout: 30000`. Among reliably-reachable cards
only the HIGH-numbered tail is available → target #300.

## Diagnosing a card's team read-only against shared dev (no backend edits)
- `npx convex data cardChecklist --limit 30000` → grep the bscCardId. Column order:
  `_id|_creationTime|cardName|cardNumber|features|lastUpdated|listingDescription|listingTitle|platformData|playerIds|selectorOptionId|sortOrder|sourcePlatformIds|teamCheckDoneAt|teamOnCardIds`.
  Empty teamOnCardIds ⇒ line ends blank; populated ⇒ ends `["<id>"]`;
  teamCheckDoneAt is a 13-digit ms before it.
- `getCardChecklist` requires admin → NOT runnable via `npx convex run` (the CLI
  has no auth identity); use `data` dumps. Internal
  `getForBscTeamCheck(cardChecklistId)` returns `{bscCardId, needsCheck}`.
- Whole-set health check = grep the selectorOptionId across the dump and compare
  populated-vs-blank teamOnCardIds counts.
- The `playerIds` column is the player, not the team — don't confuse them.

## Lesson worth keeping from the 2026-07 straggler incident (resolved)
47 of 335 cards sat permanently unenriched because `enqueueBscTeamBackfill` used
a blind `.take(1000)` re-scanned from the top; once the table passed 1000 rows a
page boundary landed mid-batch-insert and stranded rows no rerun could reach.
Fixed by switching to cursor-based `.paginate()`.
**A `remaining: 0` from a paginated-scan backfill only means "nothing left in the
SCANNED window" — with no advancing cursor that is NOT "nothing left in the table."**
