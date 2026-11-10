---
name: patterns-neo464-dashboard-aggregator
description: Auditing a signed-in dashboard that aggregates many owner-scoped reads (read-once queries + one stamp mutation) and a logged-out /demo that reuses the signed-in shell; plus agent memory landing under apps/web/.claude
metadata:
  type: project
---

NEO-464 added `convex/dashboard.ts`: seven signed-in queries and one stamp
mutation, most read once on mount (`useConvex().query`), one subscribed.

**Per-function owner derivation checklist (what held)**
- Owner index from `requireSignedIn` for every per-user table
  (`by_owner_*`, `intakeRuns.by_user_and_activity`, `marketplaceSales.by_owner_date`).
- Container args (`containerId: v.string()` + `normalizeId`) re-check
  `binder.ownerId === caller` before reading fits/state keyed by binderId.
- `HomeSides` re-checks the home's owner, so a line's home is never trusted.
- Secondary `ctx.db.get` of a parent id stored on an owned row (a run's
  `homeId`) relies on the WRITERS having checked ownership; confirm both the
  create and the re-home door do, and suggest an inline re-check anyway.
- Sales projection must be a strict subset of the existing `listSales`
  shape: no `orderId`, `platformCardId`, `sellerSku`; `listingCredentialOf`
  also returns `sellerId`, so check only `hasCredentials` is used.

**Budgeted multi-read queries:** check what the budget counter skips (parent
lookups, per-home gets, label reads) and whether the pre-read budget check
lets one more full-size read through. Compute the real worst case against
Convex's per-function read limits; it is self-DoS only when every read is
owner-scoped.

**Demo reusing the signed-in shell:** the shell's nav hook (`useIsAdmin`) is
Clerk-only, so `BinderLayout` is safe outside ProtectedLayout; re-grep the
import graph of the screen, fixture and shell for `convex/react` /
`_generated/api`. No spec asserts "no Convex call" on /demo; the grep is the
only guard.

**Hygiene:** an agent run with cwd `apps/web` writes its memory to
`apps/web/.claude/agent-memory/` (untracked, not gitignored). Flag it so it
is moved to the root store or dropped, never `git add`ed in place.
Related: [[patterns-neo350-public-demo-and-prefill]], [[patterns-public-function-auth-registry]].
