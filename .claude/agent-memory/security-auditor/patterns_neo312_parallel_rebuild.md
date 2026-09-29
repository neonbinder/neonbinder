---
name: patterns-neo312-parallel-rebuild
description: NEO-312 parallel build (copy insert cards, re-link per side, delete-then-insert across transactions) — the invariant-5 rebuild classification, the unfetched-side guard that must not be pause-only, and the cheap no-schema concurrency guard
metadata:
  type: project
---

A "rebuild" that deletes a row's cards and re-inserts copies across several
transactions (an action looping internal mutations) has three recurring traps:

1. **Invariant 5 needs the old refs classified BEFORE the delete.** Three kinds:
   (a) side fetched OK and upstream no longer returns the ref: may drop, operator
   told; (b) upstream still returns the ref but the new link key missed it
   (ambiguous or no match): dropping it is losing a live link; (c) the side was
   not fetched at all (paused, not owned, or owned but chain-unreachable). A
   post-hoc `earlierLinksMissing` count lumps all three together. Check that the
   block guard covers every unfetched side with old links, not only the paused one.
2. **Mid-delete block = partial wipe.** A per-page re-check that refuses page N
   leaves pages < N deleted. The blocked result must still report what was
   removed, and a re-run that hits the same block stays stuck.
3. **Concurrency without a lock.** Client "held" flags are per-mount React
   state; navigating away and back re-arms the button while the action is
   still running on the server. Cheap no-schema guard: the first insert page
   requires the target to be empty inside its transaction, and later pages
   require the run's first created row to still exist (OCC serialises the rest).

Auth/validator shape was clean (requireAdmin on both public fns, ids-only args,
counts-only returns); the public-function registry entries were the miss again,
see [[patterns_public_function_auth_registry]].
