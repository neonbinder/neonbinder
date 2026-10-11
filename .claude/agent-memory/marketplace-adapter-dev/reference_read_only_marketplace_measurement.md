---
name: read-only-marketplace-measurement
description: How to measure what a sync or fetch WOULD produce (SL review rows, parallel card counts, one-sided cards) without writing NB rows, for choosing E2E fixtures
metadata:
  type: reference
---

To pick an E2E fixture from live marketplace data without consuming a
fresh-only path (a cold year, an empty checklist), measure read-only:

- **SportLots set lists / checklists:** `api.adapters.sportlots.fetchSportLotsSelectorOptions`
  (`level: "insert"` is the brand-year flat set list) and `fetchSportLotsChecklist`
  are public admin actions that write nothing. Pass SL ids in `platformFilters`
  (read them off existing rows' slots, e.g. sport `BB`, year, manufacturer).
- **A brand's SportLots review:** feed that list to the pure `routeSlSets`
  (`convex/selectorSyncMatch.ts`) with `knownSetNameKeys` built from BSC's
  year-wide setName list (`fetchBscSelectorOptions`). This reproduces the sync's
  classification, folded-label order included, with no review doc written.
- **Checklist pairing outcome (one-sided cards, unknown names):** the setbuild
  tool's `fetchCandidates` writes only candidate staging rows; always
  `checklistCandidates.discardCandidates` in a `finally`. Check names with
  `players.nearMatches` / `teams.nearMatches` (exact confidence), never with
  `resolveChecklistEntities`, which opens a review batch.
- A direct `fetchBscChecklist` with hand-built filters is refused ("no
  BuySportsCards ids to scope the request with"); its facet scoping comes from
  slot tags, so measure the BSC side through `fetchCandidates` instead.

Scripts that import Convex/tool modules from a scratch dir need `.mts` (tsx
treats `.ts` outside the package as CJS and rejects top-level await).

Related: [[judge-twins-before-filtering]].
