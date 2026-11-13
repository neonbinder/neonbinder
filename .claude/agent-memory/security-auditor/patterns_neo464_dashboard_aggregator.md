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

**Carried timestamps read through a side filter (round 2, `addedAt`).**
A per-row stamp that only one door SETS but every move CARRIES (split keeps,
fold keeps the newer) is safe from forgery when no public args validator
(`copyDetailsValidator`, undo payloads) names it: grep the field against
every `v.object` used as args, and every `insert`/`replace` site, before
calling it server-authored. The read side is owner-indexed and bounded, but
a carried stamp lands rows on the OTHER side (Sell moves a binder line into
a box with its stamp), and a post-read side filter (`HomeSides.keep`) on a
`take(N + 1)` window lets those rows crowd out the wanted ones and makes
`truncated` count rows that are never shown. Self-only, so a correctness
note, never an exposure finding.

**Early-exit change on a catalog walk:** replacing "stop at N found" with a
"settled" rule that must step a window past the Nth entry usually runs the
walk to its hop cap. Re-cost it per load (hops x (index reads + uncached
ancestor chain)); bounded is fine, but say the new typical, not the old.

**Test seeds into marketplace-adjacent tables (round 3).** A seed that writes
"only where NB does not poll/push for the caller" is quiet only until that
account starts polling or pushing. Check every later reader:
- the order poll re-reads each stored NON-FINAL order by its `orderId`
  (`listingSales` "stored orders not final" refresh), so a seeded open order
  becomes a marketplace call with a fabricated id every tick once polling
  starts; filter the seed prefix in `pollInput` or seed a final status;
- an outbox row left behind is drained when pushing starts, and widens the
  run to its variant (a binder-only fallback card pulls in a variant NB
  would not otherwise touch);
- a sync record carrying `lastSuccessAt` flips the first real run from a full
  read to incremental (`claim.lastSuccessAt === null` gates the full read);
- `claimVariant` does not clear `lastError`, so a marker-in-`lastError`
  cleanup can match a record a real run is holding (`status: "running"`);
  deleting/replacing it drops `conditionsPushed` (NEO-475). Guard on status.
Related: [[patterns-testing-endpoint-gate]], [[patterns-neo370-scheduled-marketplace-poll]].

**Shape-change re-audits (NEO-539, intake per-run guesses).** When a capped
aggregate moves from one global preview list to per-row lists, check a
cross-row cap still bounds the total (each id becomes a hydration read), and
that a `take(N + 1)` "more exists" probe uses only `length`, never the extra
row's content. A row skipped by an ownership `continue` (foreign/missing
home) should not count toward any tally; it also does not set the "floor"
flag, which is a correctness note, not exposure.
