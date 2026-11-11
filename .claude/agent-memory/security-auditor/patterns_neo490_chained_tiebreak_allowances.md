---
name: patterns-neo490-chained-tiebreak-allowances
description: Card-year player narrowing chains several tie-break rules, each with its own per-name allowance and a meter check only at its start; how to price the worst case, and the pure-compute admin action shape that held (NEO-490)
metadata:
  type: feedback
---

`narrowSameNamePlayersByCardYear` (players.ts) runs rules in order (4 team-in-year,
6 Hall of Fame rivals, 6b career team). Each rule checks the shared
`CardYearTeamCache` meter (`reads >= budget`) ONCE, before it starts, then may
consult up to its own per-name allowance. So the real ceiling is:

- paged commit prelude: `budget - 1 + sum(per-name allowances of every rule)`
  per transaction, not `budget`. Recompute that sum whenever a rule is added.
- one-shot callers (`resolveNamesForReview`, 25 names per internalQuery) pass NO
  cache, so every name, and every rule inside a name, gets a fresh cache: the
  bound is `names x (player scan + sum of allowances)`, with no memo across rules.
- Livelock for a first-name-of-page exhaustion is covered by the `walked > 1`
  guard in the prelude; check any new exhaustion return goes through it.

**Why:** a new rule looks bounded by its own constant; the transaction cost is
the chain, and the gate path re-arms per name ([[patterns-neo296-transaction-bounds]] Q2).

**How to apply:** for any new tie-break rule, list every rule after the meter
check, add their allowances, multiply by names per transaction for the
uncached path, and compare with the ~900 comfortable / ~1,800 straining
house line. A read-only internalQuery far under Convex's hard read cap is a note.

Shape that held for a pure-compute public admin action
(`applyPublishedChecklistPairs`): `requireAdmin` first, array cap checked after
the gate, re-uses the fetch's server-side re-check, no `ctx.db`/`runMutation`,
logs counts only, pinned in publicFunctionAuth.test.ts with a source-order
assertion plus anonymous and non-admin refusals.

A new return field keyed on `candidateKey` (marketplace ref, else `#number`) is
not new exposure when the same refs already reach the client in the candidate
rows' `platformData`; it is routing inside the adapter boundary. Still check
the `#number` fallback for card-number collisions (invariant 7).
