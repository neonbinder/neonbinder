---
name: patterns-neo237-all-brands-view
description: NEO-237 All Brands view / Unknown bucket / setCandidates audit — auth is clean and the sentinel stays in the adapter boundary; the durable traps are a reserved row name with an unguarded store door, a candidate table whose `side` is not what keys the slot on Create, sibling prefixes that are never checked for fold-collisions, and audit fields omitted by validator but not pinned by test
metadata:
  type: project
---

Audit rules that came out of NEO-237 (pinned "All Brands" view, `metadata.setNamePrefix`,
`setCandidates`, `brandRehome.ts`, `slBrandAxis.ts`), reusable on any similar change:

1. **A reserved NB display name has FOUR doors, not three.** `checkCustomSelectorValue`
   (custom form + `addCustomSelectorOption`) and `planValueRename` refuse the name, but
   `storeSelectorOptions`' insert branch does not — a public admin call, or an upstream
   option whose id stops satisfying the sentinel predicate, can still mint a row wearing
   the view's name. Grep the store insert path whenever a name is reserved.
2. **A side-table row with a `side` field must key the slot it creates.** `createSetFromCandidate`
   writes `candidate.marketplaceId` into the SportLots slot unconditionally; a `"bsc"` row
   would put a BSC id in an SL slot. Check `initialSlots({ [side]: … })` vs a literal side.
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
   keeps every M:1 holder. `grep -rn isSl…Id` outside `convex/` should return nothing.
6. **Armed backfill shape held**: internalMutation, dry-run default, `confirm` + env flag,
   `SCAN_LIMIT+1` truncation flag, `parentId` escape hatch (unvalidated, harmless), `MAX_REPORTED`
   cap, one JSON log line of counts. Same as NEO-272/NEO-293.

**How to apply:** on any change that reserves a name, adds a candidate/side table, adds a per-row
routing fact, or adds an admin-gated read over a table with audit columns, run checks 1–4 first.
