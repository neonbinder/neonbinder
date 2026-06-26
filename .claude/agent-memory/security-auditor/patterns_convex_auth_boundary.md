---
name: patterns-convex-auth-boundary
description: NeonBinder Convex auth convention — every public adapter/set-builder action/query/mutation must gate with requireAdmin (or be internal*); public actions calling the browser proxy without it are a finding
metadata:
  type: project
---

In `neonbinder_web/convex`, the auth boundary is `requireAdmin(ctx)` from `./auth` (verifies a signed Clerk JWT and checks `role === "admin"` from the `convex` JWT template's `role` claim). `getCurrentUserId(ctx)` only returns the subject; it is NOT an authorization check.

**Why:** Set Builder + marketplace adapters are admin-only operator tooling. Every sibling adapter action follows this: `fetchSportLotsSelectorOptions`, `fetchSportLotsChecklist`, `fetchBscSelectorOptions`, `fetchBscChecklist`, and all `selectorOptions.ts` queries/mutations call `await requireAdmin(ctx)` as the first handler line. `getBscToken` was even converted from a requireAdmin-gated public action to an `internalAction` because "there is no longer any legitimate non-backend caller."

**How to apply:** When auditing a new Convex function under `convex/`:
- If it is `query`/`mutation`/`action` (public RPC), it MUST call `requireAdmin(ctx)` first — UNLESS it is an intentional public-data endpoint that strips PII (e.g. `players.ts`/`teams.ts` public lookups use `toPublicPlayer`/public validators to drop `createdByUserId`; reference data, not credentials).
- If it should never be frontend-callable, it must be `internalQuery`/`internalMutation`/`internalAction`.
- A public `action` that mints an OIDC token and calls the Cloud Run browser proxy WITHOUT requireAdmin is a real finding (HIGH): any signed-in non-admin user can drive the privileged backend service directly. Found exactly this on `convex/adapters/tcdb.ts` `fetchTcdbSetData` (NEO-38 PR B-1) — the in-band caller `fetchCardChecklist` is gated transitively, but the action is independently exposed on the public API.

See [[project_credential_architecture]] — Convex never touches Secret Manager; the browser service does. TCDB is public/no-creds, so the tcdb finding is an authz/abuse issue (driving the proxy), not a credential-exposure issue.
