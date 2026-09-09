---
name: patterns-neo137-platform-slots
description: NEO-137 slot-keyed marketplace mapping — auth is clean (all requireAdmin), but commit auto-attaches BSC-supplied set ids to the parent row uncapped, bypassing MAX_ATTACHED_PER_SIDE and contradicting the schema's own documented invariant
metadata:
  type: project
---

NEO-137 re-keys `selectorOptions.platformData` from `string | string[]` to a
slot map (`{bsc: {b0: "slug"}}`), adds `platformSlotSeq` (monotonic, never
rewound) and `platformLabels`/`primaryPlatformId` keyed by SLOT. Cards point up
via `cardChecklist.platformData.<side> = {ref, src}` where `src` is a slot key.
Helpers: `apps/web/convex/platformSlots.ts` (pure, no ctx).

**Auth is clean.** Every new/changed public fn in `selectorOptions.ts` /
`setReconciliation.ts` calls `requireAdmin` first, including the new
`resolveChecklistEntities` action. Nothing became non-admin-reachable.
`fetchCardChecklist` still has no direct `requireAdmin` (transitively gated via
`getAncestorChain`) — pre-existing, see [[patterns_set_metadata_admin_gate]].
selectorOptions/cardChecklist/players/teams are single-tenant operator data, so
there is no cross-tenant/IDOR boundary here; entityReviewQueue batches are
scoped per (selectorOptionId, createdByUserId).

**FIXED as of 2026-09-01 — verify before citing.** `resolveCardSlots`
(selectorOptions.ts ~L115) no longer allocates: it resolves `wire.setId` only
against slots ALREADY attached to the parent row (`src = slotById[side][setId]`)
and leaves `src` undefined otherwise, exactly as the schema comment always
claimed. The description below is the pre-fix behavior, kept because the
amplification path it names (an injected slug widening the next privileged BSC
fetch via `slotIds(ancestor, "bsc")`) is still the reason the guard matters. See
[[patterns-checklist-commit-trust-boundary]] in the monorepo memory dir.

**The recurring trap (historical) — cap bypass via the commit path.**
`resolveCardSlots`, called from `storeCardChecklist` and `commitCardChecklist`,
USED TO ALLOCATE a slot on the parent `selectorOptions` row for
every distinct `setId` a committed card names. The setId on the BSC side is
`sourceBscSetSlug = r.setName`, a raw field of the BSC bulk-upload response
(`convex/adapters/buysportscards.ts`) — untrusted marketplace input. That path
has no `MAX_ATTACHED_PER_SIDE` cap (the operator path `attachPlatformIds` does),
no length cap, no membership check against the ids actually queried, and no
label/audit. `schema.ts`'s own `cardPlatformRefValidator` comment documents the
SAFE behavior ("Absent when the ref cannot be attributed to any set attached to
this card's parent row … until an operator attaches the set it came from") —
the implementation does the opposite. Feedback loop: `fetchCardChecklist` sets
`bscPlatformFilters[level] = slotIds(ancestor, "bsc")` (ALL slots), so an
injected slug widens the NEXT privileged browser-service fetch, and
`getUsedInsertIdentifiersBySet` reports it as "used", blocking sibling
variantTypes in the reconciler.

**How to apply:** when auditing any future write that touches
`selectorOptions.platformData`, ask which of the three write families it belongs
to — the operator path (attach/detach/rename: capped + label-validated), the
reconciler path (`storeReconciledOptions`/`storeSelectorOptions`: uncapped
NUMBER of ids on insert; labels themselves ARE validated — `allocateSlots`
(`platformSlots.ts:348`) and `setPrimarySlotId` (`:505`) both call
`assertValidSlotLabel`, non-empty and <=200, though NOT control-char-free), or
the card-commit path (`resolveCardSlots`: uncapped, marketplace-driven). The
per-side COUNT cap is only enforced on the first.

**Other confirmed NEO-137 gaps (all admin-only / robustness):**
- `resolveChecklistEntities` takes a client-supplied `sportId` that used to be
  server-derived inside `fetchCardChecklist`; no `level === "sport"` check
  (commit HAS one) and neither checks it is an ancestor of `selectorOptionId`.
- `entityReviewQueue.startBatch` RESUMES a batch for (selectorOptionId, user)
  and never tops it up. NEO-137 makes the unknown-name set depend on the
  operator's pairing choices, so an abandoned batch + a differently-paired
  re-run silently commits cards with no playerId (`if (!decision) continue`).
- `setPrimarySlotId` reuses the primary slot KEY for a different marketplace id
  on re-reconcile. Slot keys stop detach-repointing, not primary-refresh
  repointing, and the reconciler's match is fuzzy (Levenshtein).
- `isSlotKeyForSide` is exported but never called; detach/rename take a bare
  `v.string()` slot (fails safe).
- No backfill ships for the shape change and it is not a superset of the old
  shape — verify existing docs pass Convex schema validation before any deploy.

Credentials/PII: none. No `services/` changes, no Secret Manager, no
credential flow. See [[project_credential_architecture]].
