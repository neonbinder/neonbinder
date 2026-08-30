---
name: patterns-selector-options-admin-model
description: SetSelector/selectorOptions security model — admin-only global taxonomy, where marketplace-fetch gating lives, and the getSelectorSyncStatus info-leak class
metadata:
  type: project
---

# SetSelector / selectorOptions security model (neonbinder_web)

## Admin-only global taxonomy (no per-user IDOR class)
`selectorOptions` (convex/schema.ts) is a GLOBAL admin-managed taxonomy. NOT user-partitioned (only an audit-trail `createdByUserId` on custom entries — not an isolation key). EVERY read/write goes through `requireAdmin(ctx)` (convex/auth.ts). So `parentId`-driven ancestor-chain traversal (`getAncestorChain`) cannot cross a user boundary — there is no per-user data to leak. `parentId` is `v.id("selectorOptions")` (must be a real row). No IDOR in this subtree.

## requireAdmin IS the prod fail-closed gate for marketplace fetches
`requireAdmin(ctx)` (auth.ts:42) = signed-in AND `role === "admin"` (role from Clerk JWT `publicMetadata.role`). There is NO separate "marketplace-disable env flag" — admin-gating is the prod gate (non-admins can't fetch). The env-flag fail-closed pattern in this repo is for TEST/RESET surfaces only: `ALLOW_RESET_SET_BUILDER_DATA` (resetSetBuilderData), `TESTING_RESET_SECRET` (testing.ts), `E2E_QUEUE_SECRET` (http.ts/e2eQueue). Do NOT expect a marketplace on/off flag.

## Marketplace-fetch entry points (all requireAdmin first, defense-in-depth at leaves)
- `ensureSelectorOptions` (action, the NEO-47 "door") → requireAdmin first, then dispatches via `ctx.runAction` (NOT scheduler — scheduler drops auth identity; runAction propagates it).
- `fetchAggregatedOptions` / `syncSetsAcrossManufacturers` (selectorOptions.ts) — own requireAdmin + own `isCustomSubtree` gate.
- `fetchRawOptions` (setReconciliation.ts) — own requireAdmin (line ~304) + (NEO-47) own `isCustomSubtree` skip.
- Leaf adapters `fetchSportLotsSelectorOptions` / `fetchBscSelectorOptions` independently requireAdmin. SportLots selector fetch DOES use stored session cookie (getSportLotsCookie → internal.credentials.getSiteToken) — these are credential-touching, not anonymous.

## getSiteToken contains its own errors
`internal.credentials.getSiteToken` swallows inner errors (incl. getIdTokenClient throws that contain NEONBINDER_BROWSER_URL / "GOOGLE_APPLICATION_CREDENTIALS_B64 not set") and returns null — does NOT propagate infra detail to callers. credentials.ts enforces https:// for non-loopback browser-service URLs (refuses unauthenticated remote sends).

## RESOLVED (verified 2026-08-29) — getSelectorSyncStatus is now admin-gated

This file previously recorded `getSelectorSyncStatus` (query, selectorOptions.ts)
as an UN-GATED public query. **That is no longer true** — it calls `requireAdmin`
like every sibling, with a comment saying so. Re-verified by a full sweep of all
129 public exports in `convex/` (see
[[patterns-public-function-guard-sweep]]).

The residual, still worth watching: `selectorSyncStatus.message` is populated
from `res.message` on the failure path and raw `e.message` on the catch path,
and `EntityColumn.tsx` renders it verbatim. Admin-only now, so the disclosure
boundary is admins rather than any signed-in user — but the sanitize-on-write
principle still applies to any new reactive-status surface: store a user-safe
string, keep raw error detail in console/PostHog.
