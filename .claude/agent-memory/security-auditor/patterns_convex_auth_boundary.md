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

## Corrigendum (NEO-214, 2026-09-04): never put `requireAdmin` on an `internal*` function

`requireAdmin` belongs on PUBLIC functions only. On an `internalMutation` /
`internalAction` it is not defence-in-depth, it is a **bug**: the only
principal that can invoke an internal function directly is an admin-key /
deploy-key holder via `npx convex run`, and such a call carries **no user
identity**, so `ctx.auth.getUserIdentity()` is null and `requireAdmin` throws
`Not authenticated` on every legitimate run.

`--identity` does not rescue it. The CLI's `setAdminAuth(token,
actingAsIdentity)` encodes the identity into the admin token as
`<token>:<base64 identity>`; supplying one makes the request *act as that
user*, which drops the admin privilege that lets the call reach an internal
function at all. Empirically (NEO-214 CI, confirmed on dev): `convex run
--identity` reaches only PUBLIC functions; internal functions are reachable
only WITHOUT `--identity`. So the two requirements are mutually exclusive —
you cannot have both an internal function and an identity-based check inside
it.

**The correct trust model for an internal destructive function:**
- AUTH = the deployment's admin credential (`convex login`, or
  `CONVEX_DEPLOY_KEY`). A function-level check cannot constrain that principal
  anyway — it can already `convex deploy` replacement code, `convex import
  --replace-all`, and `convex env set`.
- The client boundary = the platform. Internal functions are absent from the
  generated `api` object and rejected over the client protocol.
- ARMING = **env-var** checks (`process.env.SOME_FLAG !== "true"`) plus a
  `v.literal("CONFIRM")` arg. Env reads work under a bare admin-key call, so
  put the arming check next to the delete — that is the guard that replaces
  `requireAdmin`'s "as close to the delete as possible" role.

**Audit consequence:** when a branch removes `requireAdmin` from internal
functions, do NOT score that as a regression on its own — check instead that
(a) the arming check was hoisted down to each destructive function rather than
left only at the entry point, and (b) something in CI pins the functions as
`internal*` by reading the source, since "internal by construction" has become
the whole model. See [[patterns_public_function_auth_registry]].
