# SetSelector sync redesign — design plan (2026-06-14)

## Why (root cause, evidence-backed)
#28's stuck "Syncing Variant Types" (custom column never shows "+ Custom") is a **symptom**, not the disease:
- The backend custom-subtree skip is an **18ms no-op** — proven via Convex logs (`error_class:"skipped_custom_subtree", duration_ms:18`). Not a slow backend.
- The column still hangs in `mode="sync"` for 45s because the FE **`onDone` (sync→idle) handoff is occasionally dropped** (`useSelectorSync` discards a result via its `mountedRef`/`runId` guard if the form is torn down/superseded before the fast result resolves). Intermittent — the same drill passed on a re-run.

**The disease: the FE-driven sync state-machine in `EntityColumn` + the per-form `onDone` handoff.** It's a fragile seam present on every column.

### Owner decisions (2026-06-14)
- "Custom subtrees don't read marketplaces" must live **wholly in the backend** (it already does: `isCustomSubtree` in `fetchAggregatedOptions`). Do NOT add a duplicate FE check — it saves ~18ms and adds drift risk.
- Preferred model: **FE reads from Convex (reactive + cached); only when the table is empty does the backend run the full marketplace sync.** (This is already ~the model — the refinement is moving the sync *trigger* out of the fragile FE state-machine.)
- **Governing principle (2026-06-14, crystallized): a marketplace-agnostic FE.** The FE represents only NB's *canonical* hierarchy shape and calls the backend with what NB knows — its **position** in the hierarchy (`level` + `parentId`, transitively the whole ancestor chain). The backend owns EVERYTHING about how to get (or skip) the data for each level + each marketplace: which adapters to call, the **SL-set ↔ BSC-Base-variant mapping**, manufacturer prefix-matching, the custom-subtree skip, merge-vs-reconcile. **Adding a marketplace must be a backend-only change** — the FE never learns marketplaces exist; it only changes when NB's own model of "a set" changes. (The existing cross-taxonomy stitching is KEPT — it just lives wholly in the backend.)

## Current architecture
**Read side (good — keep):** `EntityColumn` renders `items = useQuery(getSelectorOptions,{level,parentId})` — reactive, client-cached. Sync results are persisted to the `selectorOptions` table, so data is already cached server + client side.

**Sync side (fragile — the target):** `EntityColumn` is a 3-mode state-machine (`idle`/`sync`/`custom`) with 4 refs (`autoSyncedRef`, `hasSyncedRef`, `prevModeRef`, `wasVisibleRef`) and effects for: scroll-into-view, first-sync latch, parent-change reset, freeze-on-interaction, and auto-sync-on-empty. On an empty column it flips `mode="sync"`, renders a per-level `*Form`, and depends on that form calling `onDone()` to return to `idle` (the only mode where "+ Custom"/"Sync" render).

**Three sync backends behind that one seam** (see table in chat). All share the failure mode: EntityColumn → sync mode → form runs async → `onDone` flips back; a dropped/late `onDone` strands the column in sync with no "+ Custom". `drill-forms-onDone.test.tsx` already exists — this handoff is load-bearing.

**Must preserve:** the recoverable-error UX (Retry/Cancel on sync failure) + `selector_sync_fe_timeout` PostHog telemetry; `requireAdmin` + prod fail-closed gating on any marketplace-fetch entry point.

## Target architecture — decouple READ from POPULATE; backend owns the decision
1. **Read (unchanged):** `getSelectorOptions` query drives display.
2. **Populate trigger (one door, marketplace-agnostic args):** one backend **mutation** `ensureSelectorOptions({level, parentId, force?})`, called once when a column opens. The FE passes ONLY its canonical position — no `parentFilters`, no per-marketplace hints. The backend expands the ancestor chain from `parentId` and **decides everything via an internal per-level dispatcher** (NOT three app-facing actions): rows present → no-op; custom subtree → no-op (`isCustomSubtree`); else run the level's strategy and `ctx.scheduler` the work. Returns immediately. (Mutations can schedule actions; queries can't — that's why the trigger is a mutation, not a magic query.)
   - Per-level strategies behind the dispatcher (collapse today's 3 actions): **aggregate** (SL+BSC merge) for sport/year/manufacturer/variantType; **sets** (BSC-by-year + SL-Base mapping + manufacturer prefix-match) for setName — KEPT as-is, just behind the door; **reconcile** (raw + auto-match + human-resolve) for insert/parallel.
3. **Reactive sync status (new):** a small `selectorSyncStatus` table keyed by (level, parentId) → `{status:"syncing"|"error", message, requestId}`, written by `ensureSelectorOptions` (syncing) and the sync action (clear/error). FE reads it via `useQuery` and derives loading/error/Retry — replacing the FE mode flag. Retry = `ensureSelectorOptions(force:true)`.
4. **EntityColumn:** drop the `sync` mode + the sync refs + auto-sync/onDone machinery. Keep: render `items`/empty-state, a *derived* loading/error indicator, and the `custom` add form (synchronous — no async race). "+ Custom"/"Sync" render whenever not loading.

**Net:** no `onDone` handoff to drop → the stuck-sync class is gone; all sync-decision logic (incl. custom-skip) is backend-only; Convex reactivity drives the UI.

## Migration (phased)
- **Phase 1 — 4 aggregator levels** (sport/year/manufacturer/variantType via `fetchAggregatedOptions`+`useSelectorSync`). Uniform, well-understood, and where #28/#30/#31 live. Build `ensureSelectorOptions` + `selectorSyncStatus`; migrate these 4 forms + EntityColumn; validate cluster + must-stay-green.
- **Phase 2 — setName** (`syncSets`). Same pattern, one backend.
- **Phase 3 — insert/parallel reconciliation** (`fetchRawOptions`/ReconciliationModal). Most complex (multi-step modal). Needs its own analysis — likely keeps the modal but routes the populate-trigger through `ensureSelectorOptions`. Deepest risk; do last.

## Risk / validation
- Most-tested, most-fragile core (per NEO-46/47 history). Validate every phase through the local queue harness: **must-stay-green** = #27 features-propagation, #32 set-attributes-edit, team-picker, sets-base, setup cascade; **should-go-green** = #28/#30/#31.
- Update/keep `drill-forms-onDone.test.tsx` + `EntityColumn.*.test.tsx`.
- security-auditor review on `ensureSelectorOptions` (gates marketplace fetches).
- This is a product change to the Set Builder heart — bigger than a flow fix. Worth it: kills a bug class, not one flow.

## Open questions
- `selectorSyncStatus` as a new table vs fields elsewhere (empty column has no natural row → a dedicated table is cleaner).
- Does freeze-on-interaction / collaborative background re-sync still have a purpose once the mode-machine is gone? (Likely drop; reactivity covers collaborative updates.)
- Can the insert/parallel ReconciliationModal fit the ensure-trigger, or stay bespoke (just remove its onDone-strand risk)?
- Manual "Sync" button → maps to `ensureSelectorOptions(force:true)` (keep refresh capability).

## Phase 1 — IMPLEMENTED (2026-06-14, on jburich/sync-maestro-agent-memory; NOT pushed)
Commits: `39841c4` backend · `f225b4a` FE · `ba19e01` new-path test · `f168f2f` auth fix.
- **Backend:** `selectorSyncStatus` table; `getSelectorSyncStatus` query; `setSelectorSyncStatus` internalMutation; `ensureSelectorOptions` **action** — one door: already-populated → no-op; custom-subtree → no-op (uniform skip); else mark "syncing", run `fetchAggregatedOptions` inline via `ctx.runAction`, clear/error status. Derives `parentFilters` from the chain (FE passes none).
- **FE:** `EntityColumn` guarded dual-path (`useEnsureSync`) — reactive `selectorSyncStatus` drives loading/error; `ensureSelectorOptions` fired on empty; NO sync mode / `onDone`. Wired on sport/year/manufacturer/variantType (`syncingLabel` matches the legacy "Syncing X" headings the flows assert). setName/insert/parallel keep the legacy path → Phases 2-3.
- **GOTCHA (cost a debug cycle, worth remembering):** `ensureSelectorOptions` MUST be an action, not a mutation + `ctx.scheduler`. **Scheduled functions run with NO auth** → `fetchAggregatedOptions`' `requireAdmin` threw "Not authenticated", the sync silently errored, and the loading box flashed syncing→error (so #26's "Syncing Sport Options" assert missed it). `ctx.runAction` from an authenticated action PROPAGATES the identity; the scheduler does not.
- **Validation:** 19 component tests green (old path byte-identical + new path: auto-ensure once, loading box, idle "+ Custom", error-not-stranded). E2E (local queue harness) ALL GREEN: #26, #28, team-picker, #32, #30, #31, sets-base, #27, setup. (#27 flaked once on the intermittent `CdpWebDriver` scroll hang — column rendered fine, sibling Baseball drills passed — green on re-run.) Deterministic proof of the core fix: no `onDone` handoff ⇒ the dropped-result stuck-sync race is structurally impossible.

## Phase 2 — IMPLEMENTED (2026-06-14; commit ae7333e; NOT pushed)
setName now routes through the same door. `ensureSelectorOptions` dispatches `level === "setName"` → `syncSetsAcrossManufacturers({ yearId })` (yearId from the chain's year-row `_id`), via `ctx.runAction` (auth propagates). All setName-specific taxonomy-stitching (BSC-only, year-scoped fetch, manufacturer prefix-match, "All Brands" catch-all, cross-manufacturer write) stays INSIDE that action — the door doesn't learn it. FE: setName `EntityColumn` gets `useEnsureSync` + `syncingLabel="Syncing Sets"` (no flow asserts that text); `SetForm` now unused for that column. EntityColumn itself is unchanged (the new path is level-agnostic).
- **Validation:** 19 component tests still green. E2E: **setup** (fresh full cascade) green — convex log confirms `syncSetsAcrossManufacturers` ran THROUGH the door ("BSC returned 476 sets", zero new "Not authenticated"); **sets-base** (real-set select) + **#27** + **#32** (already-populated read + custom-add under real Topps) green.
- Only **insert/parallel** remain on the legacy path → Phase 3.

## Phase 3 — IMPLEMENTED (2026-06-14; commit 3ad9e92; NOT pushed)
**Scope decision (owner-confirmed): backend custom-skip only.** The Phase-3 analysis (reading `VariantForm`/`ParallelForm` + the flow surface) resolved open question #3 below: insert/parallel reconciliation **cannot** fit the fire-and-forget door, because it auto-opens an interactive `ReconciliationModal` (a human resolves SL↔BSC matches and clicks Save — **no auto-write**), and `setup-insert.yaml`/`setup-parallel.yaml` **assert that auto-open + Save**. So insert/parallel **keep their bespoke modal on the legacy EntityColumn sync-mode path by design** — that form-render seam is *required* for an interactive modal. Full migration was explicitly rejected (would break the most load-bearing flows + the most complex UI for no functional gain).
- **The fix (backend-only):** `fetchRawOptions` (`setReconciliation.ts`) gained the uniform `isCustomSubtree` skip — the **3rd and last** sync backend to get it. A custom ancestor's missing BSC slug previously tripped the BSC precondition and returned `success:true` *with* `errors:[…]`, which the forms' "both-empty + errors" guard surfaced as a spurious **"Sync failed: could not load variants/parallels"** before `onDone`. Now it returns `success:true` with empty options + **no errors** → the forms route empty+no-errors straight to `onDone` (idle, "+ Custom") with no error banner. Kept the check local (`chain.some(r => r.isCustom)`) — no cross-file import, per the convention noted in `selectorOptions.ts`.
- **No FE change** — `VariantForm`/`ParallelForm` already handle success+empty+no-errors → `onDone`/idle. The form unmounts on `onDone`, so the skip's neutral `message` never even paints.
- **Validation:** custom flows green — **cards-parallel-custom** + **move-parallels-of-inserts-custom** (both drill via `util-drill-to-custom-set` → custom-set subtree → insert/parallel column has a custom ancestor) — convex log proof the skip fired 3× ("custom subtree — skipping marketplace fetch for insert/parallel"). Regression: **setup-insert** green with a real, non-skip "Fetching insert options" fetch → non-custom reconciliation intact.

## REDESIGN COMPLETE — all 3 sync backends share the uniform backend custom-skip
- **aggregate** (sport/year/manufacturer/variantType) → `ensureSelectorOptions` door → `fetchAggregatedOptions` (reactive status, auto-write).
- **sets** (setName) → `ensureSelectorOptions` door → `syncSetsAcrossManufacturers` (reactive status, auto-write).
- **reconcile** (insert/parallel) → legacy EntityColumn sync-mode + `fetchRawOptions` → human `ReconciliationModal` → `storeReconciledOptions` (bespoke by design; now custom-skip-safe).
## Security audit — PASSED (2026-06-14; fixes commit c4fd210; validated)
security-auditor reviewed the full diff (`git diff 39841c4^..HEAD -- convex/`). **All six marketplace-fetch invariants clean:** admin gating on every entry point (`ensureSelectorOptions:2351` + downstream `fetchAggregatedOptions`/`syncSetsAcrossManufacturers`/`fetchRawOptions`/leaf adapters re-check); scheduler-vs-runAction identity (door uses `ctx.runAction`, never `ctx.scheduler` — the `f168f2f` pitfall stays fixed); prod fail-closed (`requireAdmin` *is* the prod gate here); custom-skip is post-`requireAdmin` and returns only benign data; no IDOR (`selectorOptions` is global admin-managed taxonomy, not user-partitioned); `setSelectorSyncStatus` correctly an `internalMutation`.
- **HIGH (fixed):** `getSelectorSyncStatus` query lacked `requireAdmin` — every sibling query in the file gates, and `message` could carry raw backend sync detail to an authenticated non-admin. Added `requireAdmin` as the first handler line. (Blast radius was bounded — `getSiteToken` swallows its sensitive throws and returns null — but it was an unbounded raw-`Error.message` channel.)
- **LOW (fixed):** raw `res.message`/`e.message` was persisted into the reactive `selectorSyncStatus.message`. Now `ensureSelectorOptions` writes a user-safe `SYNC_ERROR_MESSAGE` constant and `console.error`s the raw detail — safe-by-construction regardless of future deeper exceptions. No Maestro flow asserts on door error-banner text (verified), and the component test mocks its own status message, so neither broke.
- **Validation:** deploy clean + 19 component tests green; **setup** green with zero new "Not authenticated" — the new `requireAdmin` gate is exercised continuously (it drives the "Syncing X Options" loading boxes setup asserts) and the admin path is intact.

## Next: fold into the NEO-47 release bundle → web PR #55 + browser PR #47 (all-at-once release).

## Resolved decisions (2026-06-14, owner)
1. **insert/parallel stays always-manual reconciliation.** Auto-match is UI assistance only; a human confirms. (Do NOT auto-write high-confidence matches.)
2. **`selectorSyncStatus` = a new dedicated table.**
3. **Drop freeze-on-interaction** (and the background re-sync) once the mode-machine is gone — Convex reactivity covers collaborative updates.

## Audit findings — insert/parallel ("is anything else in there?", 2026-06-14)
Confirmed the *only* sync-level difference for insert/parallel is reconciliation: `fetchRawOptions` fetches SL+BSC from the chain (same pattern), returns raw + `autoMatched`/`unmatchedBsc`/`unmatchedSl`, the human resolves in `ReconciliationModal`, and `storeReconciledOptions` persists the matched SL↔BSC pairs (incl. SL-Base-prefix stripping via `baseSlPrefix`). Two notes:
- **BUG/inconsistency to fix in the unified model:** `fetchRawOptions` is MISSING the `isCustomSubtree` skip that `fetchAggregatedOptions` + `syncSetsAcrossManufacturers` have. A custom insert/parallel column therefore trips the "missing BSC slugs" precondition and returns an *error* instead of skipping cleanly (a 2nd manifestation of the stuck-column class). The unified `ensureSelectorOptions` dispatcher must apply `isCustomSubtree` to ALL levels.
- **Out of scope — leave alone:** `parallelDetection.ts` / `ParallelGroupingModal` is a separate adjacent feature (prefix auto-grouping of existing inserts into parent/parallel — the "Group Parallels" UI tested by #28/#30/#31). NOT marketplace sync; the sync redesign does not touch it.
