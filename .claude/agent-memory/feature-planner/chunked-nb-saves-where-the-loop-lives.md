---
name: chunked-nb-saves-where-the-loop-lives
description: Splitting an operator save past a per-transaction bound — client mutation loop vs Convex action loop, and what each buys (read-your-writes for a modal rebuild vs one call); large E2E fixtures via the sanctioned seed hop
metadata:
  type: project
---

Two house shapes exist for an NB save bigger than one transaction, and the choice
turns on what the screen must do afterwards, not on taste.

- **Action loop** (`commitCardChecklist` NEO-189, `applySlSetReview` NEO-306):
  public `action` does `requireAdmin`, then `ctx.runMutation(internal.…Chunk)`
  with the admin id passed explicitly; impl is a plain function over
  `Pick<ActionCtx,"runMutation">` so a test can fail chunk k. Right when ONE
  logical write needs prelude/finalize or exceeds a mutation's budget.
- **Client loop** (NEO-308 Group Parallels): the modal calls the existing
  admin-gated public mutation once per chunk. Right when every chunk is already
  a complete, independently-valid write. Its edge: a mutation promise resolves
  only once this client's subscriptions reflect it, so on a mid-save refusal the
  modal can RESET and re-INIT from its live `useQuery` and be guaranteed to see
  the landed chunks. An action's response carries no such timestamp; a rebuild
  after an action needs a one-shot `convex.query` instead.

Either way the bound stays server-side and the chunker is a pure, id-only
function in an env-free module (see [[fe-imported-convex-modules-stay-env-free]]).

**Why:** NEO-308 — Accept-all produced 259 moves against a 200-entry cap; Jason
ruled no all-or-nothing wrapper (partial writes are recoverable by reopening).

**How to apply:** ask "must the screen rebuild from fresh state after a partial
failure?" — yes → client loop; "is there a prelude/finalize or a single write
over budget?" — yes → action. For E2E, a >200-row fixture cannot be built
through the UI inside R5 (each create ~8 s); the README's "costs real minutes"
seed exception (`/testing/seed-credentials?sites=<selector>`) is the sanctioned
route, still needs Jason's nod per fixture, and must write through the product's
own writers.
