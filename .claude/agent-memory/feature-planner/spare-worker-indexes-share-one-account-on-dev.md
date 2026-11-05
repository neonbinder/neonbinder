---
name: spare-worker-indexes-share-one-account-on-dev
description: Locally, WORKER_INDEX values with no TEST_EMAIL_<n> in .env.local all fall back to the unindexed TEST_EMAIL, so two "spare" workers on dev are one Clerk user and any bootstrap wipes the other's rows mid-run
metadata:
  type: project
---

The sign-in hop resolves `TEST_EMAIL_${worker}` and FALLS BACK to the unindexed
`TEST_EMAIL` when the indexed var is unset (`api/auth/testing.ts`
`resolveTestEmail`, and its dev-middleware twin `resolveDevTestEmail` in
`apps/web/vite.config.ts`). A laptop whose `.env.local` defines only
`TEST_EMAIL_0..2` therefore signs every "spare" worker (3-31) in as the SAME
Clerk user: two sessions on worker 8 and worker 9 are one account.

**Why:** 2026-11-04, NEO-432: a seller spec green with bootstrap went red on a
`--no-deps` rerun because another session's bootstrap on "worker 9" ran
`testing.resetMyTestState` on the shared account and deleted its containers
under the live page (the box picker fell to "Unsorted" only; the same
mechanism produces the "That binder or box isn't in your collection." toast).
The only container delete paths are `collectionContainers.remove` (own, empty,
non-system), `testing.resetMyTestState` (caller-scoped; the bootstrap project)
and the armed global `selectorOptions.resetCollectionContainersBatch`.

**How to apply:** when a plan or diagnosis assumes "worker 8 is mine", first
check which `TEST_EMAIL_<n>` keys the worktree's `.env.local` defines (names
only, never values). A dev red where a per-user row vanished mid-run with no
`remove` in the flow means a reset on the shared account by another session:
look for a concurrent bootstrap on ANY worker index, not only the same one.
The fix is operational (indexed accounts in the local env; Private notes) or a
harness PR (refuse the fallback when a worker index is given) run with the
full local suite.
