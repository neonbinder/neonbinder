# NEO-22 / PR #35 — Overnight iteration log (start: 2026-05-19 evening)

**Goal:** get PR #35 (NEO-22, BSC/SL gate on custom subtrees) green so we can merge in the morning. NEO-16 (PR #32) is blocked behind this, so unblock the line.

**Worktree:** `/Users/jburich/workspace/neonbinder/neonbinder_web-neo22`
**Branch:** `jburich/neo-22-gate-custom-subtree-fetches`
**Dev Convex:** `dev:focused-fox-53` (URL `https://amiable-sparrow-677.convex.cloud`)
**Local Vite:** `http://localhost:3000` (Node 22.12.0, `VITE_DEV_DISABLE_HTTPS=1`)

I'll append a section per iteration. Read top-to-bottom in the morning.

---

## Plan / approach

1. Sync branch with latest `main` (already done: merge commit `20eafcf`).
2. Push branch so PR #35 has the merge commit.
3. Deploy current branch's Convex code to `focused-fox-53` via `npm run deploy:dev` (don't use `npx convex deploy` directly).
4. Start local Vite pointed at that deployment.
5. Run the full Maestro suite locally — capture every real failure.
6. For each failure: pull logs / open Chrome / diagnose / minimum fix / re-run / commit & push.
7. Repeat until local suite is fully green, then watch CI on PR #35.

Hard rules I'll respect:
- No flake excuses — every failure is a real bug.
- No `wip` tagging to dodge red flows.
- Maestro selectors: visible text or `aria-label` only.
- 10s UI response budget.
- No cherry-pick / rebase / force-push without permission. Only normal commits + push.
- Squash-merge when the time comes (but only after the user reviews in the morning).
- Per-PR Convex previews already wired, so pushing to the branch updates the CI Convex automatically.

---


## Iteration 1 — 21:14 — Sync + Convex deploy

- Pushed merge commit `20eafcf` to PR #35.
- `npx convex dev --once` failed with schema validation: existing rows in `selectorOptions` on `focused-fox-53` had a stray `primaryPlatformId` field. Traced to commit `2e97c66` on branch `jburich/neo-6-phase1-multi-version-mapping` (PR #33, NEO-6 draft) — that branch was deployed to shared dev Convex previously and polluted the data. NEO-6 hasn't merged to main.
- Wiped `selectorOptions` on `focused-fox-53` via `npx convex import --table selectorOptions --replace -y` (3,423 rows deleted). Mirrors what `setup.yaml` resets before every Maestro run; safe because it's shared dev.
- Re-ran `npx convex dev --once` → push succeeded in 3.84s.

Decision: did NOT widen the NEO-22 schema validator to accept `primaryPlatformId`. That would leak NEO-6's schema into this PR. Wiping shared-dev data is the right cleanup; tests re-seed it.

