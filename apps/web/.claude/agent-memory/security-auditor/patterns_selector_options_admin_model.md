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

## KEY FINDING CLASS — getSelectorSyncStatus is an UN-GATED public query that surfaces raw error text
`getSelectorSyncStatus` (query, selectorOptions.ts ~2306) has NO requireAdmin. Returns `{status, message}` from the `selectorSyncStatus` table. `message` is populated by `ensureSelectorOptions`:
  - failure-path: `res.message` (e.g. precondition_missing_slug → leaks internal taxonomy/hydration detail)
  - catch-path: raw `e.message` (arbitrary downstream Error text)
EntityColumn.tsx (~line 325) renders `syncStatus.message` RAW into the UI. Two issues: (1) any AUTHENTICATED non-admin can read it directly (missing requireAdmin — inconsistent with every sibling query) and (2) raw error text is unsanitized. Fix: add `requireAdmin` to `getSelectorSyncStatus`, and sanitize what gets WRITTEN into `selectorSyncStatus.message` (store a user-safe string; keep raw detail in console/PostHog only). Same sanitize-on-write principle applies to any future reactive-status surface.
