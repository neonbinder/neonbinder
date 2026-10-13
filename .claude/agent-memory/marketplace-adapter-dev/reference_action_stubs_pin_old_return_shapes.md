---
name: action-stubs-pin-old-return-shapes
description: Convex tests vi.mock internal adapter actions with their OWN args/returns validators, so changing an action's return shape leaves every stub returning the old shape; grep the action name across convex/*.test.ts and update each stub
metadata:
  type: reference
---

The `fetchCardChecklist*` / `firstCommit*` test files replace adapter actions
(`fetchBscChecklist`, `fetchBscCardTeamNames`, `fetchSportLotsChecklist`) via
`vi.mock("./adapters/<x>", …)` with a fresh `internalAction({ args, returns,
handler })`. The stub's `returns` validator is its own copy, so when the real
action's return shape changes nothing forces the stubs to follow: the stub
still validates and returns the old shape, and the caller misreads it (a
`{}` record fed to code expecting an array throws, or worse, reads as "every
lookup failed"). Test files are not typechecked either
([[convex-test-files-are-not-typechecked]]), so tsc will not catch it.

**How to apply:** before changing an internal action's `returns`, run
`grep -rn "<actionName>: internalAction" apps/web/convex` and update every
stub in the same change, choosing a stub return that preserves what each file
was testing (e.g. an empty answer list = every lookup failed = the old
"no team" path). Then run those files, not just the action's own test.

**On a merge where both sides reshaped the action:** the grep must run AFTER
the merge, because the other side's NEW test files (auto-merged, never
conflicted) bring stubs of the other shape, and so do auto-merged tests that
call the mutation the action feeds (`resolveCandidateTeams` args). Only the
conflicted files get your attention by default; the rest show up as red
`Validator error: Unexpected field` or `.map is not a function` in the unit run.
