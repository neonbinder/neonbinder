---
name: patterns-neo211-additive-selector-sync
description: NEO-211 makes the two set-builder store mutations additive/id-keyed and adds a client-supplied coveredSides + existingId; the durable rules are fail-closed unlink, sibling-map-only existingId, primary-slot-only detach, and NEO-47's no-raw-adapter-text-in-reactive-state
metadata:
  type: project
---

NEO-211 rewrites `storeSelectorOptions` (`convex/selectorOptions.ts`) and
`storeReconciledOptions` (`convex/setReconciliation.ts`) from
match-by-display-value + delete-the-rest to additive, id-keyed matching, and
adds `getSelectorSyncSuggestions` / `applySelectorSyncSuggestions`. Audited at
plan stage 2026-09-03. Auth is not the issue here — every one of these is
`requireAdmin`-gated single-tenant operator tooling. The issue is that the plan
hands the CLIENT two new levers over destructive writes.

**The two levers and their required shape:**

1. `coveredSides` authorizes UNLINK. Anything that lets the client widen it is
   a destructive capability. Rules: absent ⇒ unlink NOTHING (never "infer from
   the items" — an old bundle that skips the `result.errors` check ships a
   partial payload and would strip links); explicit value is NARROWING only
   (effective = explicit ∩ sides that actually appear in the batch); an EMPTY
   item array never unlinks whatever is passed.
2. `existingId` (threaded from `ReconciliationModal`) is a cross-parent /
   cross-level write primitive if resolved with `ctx.db.get`. The precedent to
   copy is `commitCardChecklistChunk` (`selectorOptions.ts` ~L7060): resolve it
   ONLY through the sibling map already loaded from `by_level_and_parent`, so a
   foreign id simply misses and falls through to insert. One row may be claimed
   by at most one incoming item per call.

**Unlink must be primary-slot-only.** `hasOperatorExtras` (`platformSlots.ts:204`)
exists because an operator attaches an extra precisely for a set the scoped
automated fetch does NOT return under that parent — so "not returned" is not
evidence of "delisted" for an extra. Auto-detaching extras silently reverses
the NEO-6 protection. Same trap at the setName level: `syncSetsAcrossManufacturers`
makes one store call PER manufacturer bucket over the same (level,parentId),
so a per-call unlink pass has one bucket detaching what another bucket returns.

**NEO-47 rule that this plan would have broken.** `selectorOptions.ts:4119` and
the `ensureSelectorOptions` catch: raw sync/exception/adapter detail goes to
`console.error` only; the persisted, reactive `selectorSyncStatus.message` stays
a fixed user-safe string. That was a security-audit decision, and it still binds
even though `getSelectorSyncStatus` is admin-gated — the row is durable,
rendered in the DOM, and reachable by session replay. Per-platform failures
belong in the notice as a platform-name enum, never `${plat}: ${err}`.

**Label validation is already closed (corrects an older note).**
`setPrimarySlotId` (`platformSlots.ts:505`) and `allocateSlots` (`:348`) both
call `assertValidSlotLabel` (non-empty, ≤200), so the reconciler path does
validate labels on write. It does NOT reject control characters/newlines, and
`renameSelectorOption` has NO length cap on `value` at all — which matters the
moment a stored marketplace label can be promoted into `value` (the suggestions
"accept" path). Re-validate at accept time.

**How to apply:** when auditing any future change to these two stores, ask the
three questions in order — (a) can the client widen the set of rows that get
written or unlinked? (b) does an id from the wire get resolved by `db.get` or
through the sibling snapshot? (c) does an old SPA bundle mid-deploy reach the
new destructive branch by omitting the new arg? See
[[patterns-neo137-platform-slots]] for the slot model and
[[patterns-convex-auth-boundary]] for the gating convention.

## Code-stage audit (2026-09-03, commits ed8f552 / 02e843d)

The plan-stage conditions landed. The durable lesson from the code pass is a
**third lever** the plan did not name:

`returnedIds` is derived from the mutation's `items` array
(`selectorSyncMatch.ts:304-312`), and the unlink pass detaches any primary id
NOT in it (`selectorOptions.ts:1262`, `setReconciliation.ts:1310`). So on the
reconciler path the thing that authorises a detach is *what the operator
confirmed in `ReconciliationModal`*, not *what the marketplace returned* —
`handleConfirm` discards everything left in Pending, and DISBAND/DETACH are
one-click gestures. `coveredSides` being correct is not enough; the id universe
that authorises a detach has to come from the FETCH, not from the payload.

Corollary that flips the feature on its head at levels 6-7: the modal restores
EVERY existing row into Ready (synthesising a `PlatformItem` for ids the fetch
did not return), so a genuinely delisted set is always in the payload and can
never be unlinked — the unlink pass there fires only on operator curation, i.e.
only in the false-positive case.

**Fourth question when auditing this area:** does the set of ids that
authorises a detach come from the adapter response, or from a client array the
operator edited?

Resolved in `27e2b0c` / `e7db720`: both stores take an explicit optional
`returnedIds` (capped at `MAX_RETURNED_IDS` 2000/side); a side omitted from it
gets an EMPTY universe and is therefore uncovered (fail-closed, never falls
back to the items per-side). The aggregator builds it from the RAW pre-dedupe
adapter ids, because the dedupe keeps only the last id per normalised name and
a dropped id would read as a delisting. FE `returnedIdsFromFetch`
(`selector-sync-feedback.ts`) unions `*Options` + `unmatched*` + BOTH halves of
`autoMatched`. `planSelectorSync` is now two-pass — all tier-0/1 identity
claims resolve across the whole batch before any tier-2 name match — so item
order cannot let a name claim pre-empt an id claim.

Also confirmed durable in the shipped code:
- `checkSelectorValue` (trim, max 200, rejects control chars) is the one
  validated `value` writer, shared by `renameSelectorOption`, the modal tier-0
  RENAME and suggestion accept via `planValueRename`. `assertValidSlotLabel`
  (`platformSlots.ts:90`) still does NOT reject control chars — accept-time
  re-validation is what closes that, so never remove it.
- `applySelectorSyncSuggestions` takes no label/value on the wire; the label is
  read off the row.
- No adapter text reaches `selectorSyncStatus`: `ensureSelectorOptions` uses
  `SYNC_ERROR_MESSAGE` / `partialSyncMessage(failedPlatforms)` only. But
  `fetchRawOptions.message` and `fetchAggregatedOptions.message` DO carry raw
  adapter text as action return values — any FE that renders `result.message`
  re-opens NEO-47.
