---
name: neo279-team-fill-recompute
description: NEO-279 teamFill preview/apply actions — the "apply recomputes the plan server-side, client sends only a root id" shape closes the NEO-277 guard-parity trap by construction; its own traps are the unregistered public actions, the forward drift (apply writes fills the operator never saw), and internal page queries whose budget/NaN handling can spin the calling action
metadata:
  type: project
---

NEO-279 shipped a second preview/apply pair (`convex/teamFill.ts`) with a
different shape from NEO-277: both public fns are `action`s taking only
`{selectorOptionId}`, both call ONE shared `computeTeamFillPlan`, and the
apply re-derives every `(cardId, teamIds)` server-side, then an
`internalMutation` chunk re-reads each card and writes only if it is still
an empty candidate. Nothing id-shaped crosses the wire from the client.

What held: `requireAdmin` is the first statement of both actions (before any
`runQuery`); the level guard lives in the shared subtree query so preview and
apply cannot disagree; the write clears `bscTeamName` and never copies it;
marketplace ref is read only as a presence boolean (same clause the attention
badge uses); preview returns NB player/team names + counts only.

**Durable traps for the next such pair:**
- Shared compute path ≠ registered. Neither action had an entry in
  `publicFunctionAuth.test.ts` at HEAD; "typecheck green + unchanged registry"
  proves nothing (see [[public-function-auth-registry]]).
- Recompute-on-apply drifts FORWARD as well as back: the header only argues
  the skip direction (card teamed in between → skipped), but a teamed card
  added between preview and apply creates new rule-A answers, so apply can
  write fills the operator never saw. Cheap fix: client passes the preview's
  `fillable` and apply refuses (or reports `unexpected`) when the recomputed
  plan is larger.
- A multi-`runQuery` walk from an action is NOT a snapshot even when the
  comment says so; each page is its own transaction. Fine for empty-only
  additive writes; not fine if a later feature keys a delete/rename on it.
- Budgeted page queries driven by an action loop: `done` must be provable
  from progress. A non-finite `budget` (NaN via `Math.max(1, NaN)`) makes the
  page read nothing and return `done: false` with unchanged cursor → the
  action spins to its timeout. Internal-only today; guard `Number.isFinite`.
- Per-transaction call cap: the node walk costs one `get` (+ one index range
  in the card pager) per node regardless of card count, so the bound is the
  node count under the level guard, not the card budget.

**How to apply:** for any "client sends a root id, server recomputes" pair,
check the registry entry first, then ask what happens when the recomputed
plan is BIGGER than the one confirmed, then trace every `done`/cursor path of
the pager for a no-progress return.
