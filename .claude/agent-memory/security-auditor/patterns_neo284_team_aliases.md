---
name: patterns-neo284-team-aliases
description: NEO-284 team aliases + armed loader — the durable audit rules: an ADVISORY alias collision becomes a HARD NAME_TAKEN lock on the primary-name owner once findCollidingTeams reads the alias union; the shared write/dry-run handler pattern (one function, `write` flag, `ctx as MutationCtx`) and what to grep to prove the query leg cannot write; commit-time flag writes need the same sport re-check as the decision
metadata:
  type: project
---

Audited 2026-09-16 (diff, not plan). Auth was clean: `teams.aliasesInUse`
requireAdmin + registered in `publicFunctionAuth.test.ts`; loader is
internal-only, env flag + confirm literal asserted in every mutation.

**Rule 1 — advisory-on-write + union-on-read = lock-out.** When an identity
lookup (`findTeamsByFullName`) unions primary-name and alias legs, every
consumer that REFUSES on a hit (`findCollidingTeams` → `NAME_TAKEN`) now
refuses on an alias too. If the alias WRITE side is only advisory
(`aliasesInUse`, commit-time `saveAsAlias`), an operator can attach row A's
primary name as an alias of row B, after which A's own name/location/years
edits are refused with `NAME_TAKEN:<B>`. Check: does any alias writer let an
alias equal another row's PRIMARY name with an overlapping era? If yes, either
hard-refuse that one case at the writer or exclude alias-only hits from the
write-side collision check.

**Rule 2 — shared write/dry-run handler.** `bulkLoad.loadTeams(ctx, args,
write)` serves both the armed mutation and the unarmed `previewTeams` query,
with `mutationCtx = write ? (ctx as MutationCtx) : null`. To prove the query
leg cannot write: grep the shared function for `ctx.db.insert|patch|delete`
and for helpers that take a MutationCtx (`findOrCreateLeague`,
`resolveDefaultLeagueId`, `sync*Aliases`) — each must sit behind
`mutationCtx &&` / the ternary, never bare `ctx`. The cast is the only
escape hatch from the `QueryCtx | MutationCtx` union type, so the grep is
short.

**Rule 3 — a flag decided at recordDecision but applied at commit needs the
sport/existence re-check at BOTH ends.** `saveAsAlias` is validated (kind ===
"team", linked team in the row's sport) when recorded, and the commit prelude
re-fetches the linked team and drops it on `sportId !== args.sportId`. Any
new "remember X at commit" flag must copy both halves; the decision is a
durable record read later by a different actor.

**Rule 4 — loader per-row read cost is aliases × (2 index reads + ≤16 gets).**
64 aliases × 50 rows can exceed the per-transaction document budget; the
chunk throws and rolls back (safe), but the runbook must say to send
alias-heavy chunks smaller. Not a security finding, a convergence one.

See [[patterns-neo239-retire-custom]] for the sibling "no custom concept"
checks and [[public-function-auth-registry]] for the registry rule.
