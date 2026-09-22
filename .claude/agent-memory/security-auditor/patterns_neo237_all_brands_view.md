---
name: patterns-neo237-all-brands-view
description: NEO-237 All Brands view / Unknown bucket audit — auth is clean and the sentinel stays in the adapter boundary; the durable traps are a reserved row name with an unguarded store door, a side table whose `side` is not what keys the slot on Create (found on a candidate table built and removed the same day), sibling prefixes that are never checked for fold-collisions, and audit fields omitted by validator but not pinned by test
metadata:
  type: project
---

Audit rules that came out of NEO-237 (pinned "All Brands" view, `metadata.setNamePrefix`,
`brandRehome.ts`, `slBrandAxis.ts`), reusable on any similar change. Rules 2 and 4 were
found on a `setCandidates` table + review modal that was built and then removed the same
day (2026-09-21), because Jason ruled a set a marketplace lists is SAVED by the sync, not
offered for review; the sync now mints the set + Base directly (`setFromMarketplace.ts`).
The rules outlive the table:

1. **A reserved NB display name has FOUR doors, not three.** `checkCustomSelectorValue`
   (custom form + `addCustomSelectorOption`) and `planValueRename` refuse the name, but
   `storeSelectorOptions`' insert branch does not — a public admin call, or an upstream
   option whose id stops satisfying the sentinel predicate, can still mint a row wearing
   the view's name. Grep the store insert path whenever a name is reserved.
2. **A side-table row with a `side` field must key the slot it creates.** The removed
   `createSetFromCandidate` wrote `candidate.marketplaceId` into the SportLots slot
   unconditionally; a `"bsc"` row would have put a BSC id in an SL slot. Check
   `initialSlots({ [side]: … })` vs a literal side on any row that carries a side.
3. **Per-row routing prefixes need a sibling fold-collision check at the EDIT door.** Defaults
   (prefix = value) are unique by the sibling-name rule, but the edit mutation can set two
   brands to the same prefix; `routeBscSets` then files by sort order and there is no
   brand→brand move to undo it.
4. **"Never returned to a client" audit fields (`skippedByUserId`) are enforced by the hand-built
   `returns` validator — pin it in `publicFunctionAuthGuards.test.ts`** (the NEO-212 shape), not
   only in `publicFunctionAuth.test.ts`; the guard file is where that property lives.
5. **Marketplace-id sentinel checks are clean when**: the constant + predicate live in one env-free
   module, every caller is inside `convex/` sync/adapter code, the adapter applies the scope to the
   PARSED response only, and the sentinel id stays in `returnedIds` so the NEO-211 unlink pass
   keeps every M:1 holder. `grep -rn isSl…Id` outside `convex/` should return only the one
   admin-panel toggle that derives an on/off boolean from the row's slot (never displays the id);
   anything else outside `convex/` is a finding. A placeholder-aware name tier is safe only when
   the predicate is a server-built closure keyed on `level` (never an arg) and tier 1 is untouched,
   so a live id held elsewhere is still claimed by id before any placeholder row is "free".
7. **Write caps named "per sync" are usually per SCOPE; multiply by scopes.** `MAX_SL_SETS_PER_SYNC`
   (200) applies per brand scope in `routeSlSets`, so one Sync Sets can mint 200 × scopes rows; the
   real ceiling is `MAX_YEAR_SET_ROWS` (3000), and once a year crosses it BOTH the SL create path
   (`index_truncated`) and the BSC re-home path (`listYearSetRows`) stop for that year with no
   operator recovery. Check the year-wide index budget against the sum of per-scope caps.
6. **Armed backfill shape held**: internalMutation, dry-run default, `confirm` + env flag,
   `SCAN_LIMIT+1` truncation flag, `parentId` escape hatch (unvalidated, harmless), `MAX_REPORTED`
   cap, one JSON log line of counts. Same as NEO-272/NEO-293.

**How to apply:** on any change that reserves a name, adds a side table keyed on a marketplace
row, adds a per-row routing fact, or adds an admin-gated read over a table with audit columns,
run checks 1–4 first.
