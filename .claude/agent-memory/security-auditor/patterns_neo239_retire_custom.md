---
name: patterns-neo239-retire-custom
description: NEO-239 replaces the all-or-nothing isCustom fetch gate with per-side resolvability; the three durable traps are that a SKIPPED side still reads as COVERED (mass unlink), that dropping the display-value variant pin fails OPEN into a BSC superset, and that the SL adapter's own name fallback sits below every call site
metadata:
  type: project
---

Plan audited 2026-09-04 (`todos/retire-custom-plan.md`, code at `4f16b20`).
No credentials/PII anywhere in this surface; everything is `requireAdmin`
single-tenant operator tooling. The risk is data integrity, not auth.

**1. "Skipped" is not "covered" — the mass-unlink trap.**
`fetchAggregatedOptions` builds `coveredSides` from ERRORS only
(`selectorOptions.ts:5386-5388`, FE twins `coveredSidesFromErrors` /
`planSinglePlatformStore` in `SetSelector/selector-sync-feedback.ts`). A side
that is skipped for lack of ids raises no error, so it lands in `coveredSides`
with an EMPTY `returnedIds` — and the unlink pass (`:1416`, `setReconciliation
:1383`) detaches every child row's primary id on that side. Today this is
unreachable because `aggMissingBsc` / the isCustom gate abort the WHOLE action;
NEO-239 converts that hard abort into a soft per-side skip and opens it. Any
future per-side skip must report the skip explicitly and subtract it from
`coveredSides` **server-side in the store mutation** (an old SPA bundle keeps
sending the error-derived value for the whole cache lifetime).

**2. Absence of a BSC facet is a WIDENING, not an inert id.**
`resolveBscFacetFilters` (`bscFacets.ts`) drops an untagged slot, and
`fetchBscChecklist` compensates by ALWAYS pinning
`filters.variant = [parentFilters.variantType.toLowerCase()]` — that line runs
outside the facetFilters/platformFilters if-else, so it fires even on the
NEO-189 tagged path. Remove the display pin without making `variant` REQUIRED
at variantType level and the query goes out with sport+year+setName and no
variant axis: BSC returns base + every insert + every parallel, `MAX_CARDS`
5000. That is the NEO-22 hazard, and it hits the mainline NEO-189 rows (whose
slots are tagged `setName`/`variantName`, so no backfill will ever give them a
`variant` tag), not just the corrupted slugs. Rule: for BSC, a missing required
facet must make the side UNRESOLVABLE (skip), never omit the filter.

**3. The display-value fallbacks are not all at the call sites.**
`resolveSportLotsPlatformValue` (`adapters/sportlots.ts:175-193`) ends
`|| displayValue` and its catch returns `displayValue`; `:324-336` and
`:630-640` reach it via `?? await resolveSportLotsPlatformValue(...)`. So even
with all seven callers preconditioned, the SL adapter still builds a query from
an NB name. `fetchSetNames` also strips `parentFilters.manufacturer` as a
literal prefix off returned set names (`:693`). Fixing only the four call-site
fallbacks the plan lists (`selectorOptions.ts:5129, :5565, :5570`,
`setReconciliation.ts:510`) leaves the invariant violated one layer down.

**4. `BscFacet` is a closed literal union in the SCHEMA.**
`schema.ts:195-201` and the explicit returns validators at
`selectorOptions.ts:653/:676`. Adding `"variant"` is a schema widening: deploy
the widened validator BEFORE any backfill writes a `variant` tag, and note that
a rollback afterwards makes those documents fail validation on read. Same shape
for `metadata.isBase` against `metadataValidator` (`:431-435`). "Release-safe:
field kept optional and unread" covers `isCustom` only, not these two.

**5. What the plan gets right (do not re-litigate).**
`unlinkStalePrimary` (`selectorSyncMatch.ts:565-574`) returns undefined with no
primary slot, so dropping `if (row.isCustom) continue` at `:1419` / `:1385` is
genuinely a no-op for id-less rows. The commit diff's own `coveredSides`
(`:9252-9258`) is derived from the incoming CARDS, so it is fail-closed and
`:9277`'s isCustom skip really is subsumed by `linked.length > 0`. Dropping the
operator-delete guard at `:8426` is safe: the two surviving checks (row must be
in the `by_selector_option` snapshot, row must not be in this commit) are the
trust boundary, and `deleteCard` never had the guard.

See [[patterns-neo211-additive-selector-sync]] for the coveredSides/returnedIds
levers this builds on and [[patterns-neo137-platform-slots]] for the slot model.
