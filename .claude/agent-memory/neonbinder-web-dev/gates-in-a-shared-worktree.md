---
name: gates-in-a-shared-worktree
description: apps/web gate quirks — eslint "File ignored" on lib/*.ts is baseline; a sibling's npm ci may be mid-flight (wait, never start a second); `npm run test:unit -- <filter>` does NOT filter (use npx vitest run); link-deps.sh checks the wrong dir and main's node_modules can be stale
metadata:
  type: feedback
---

Things that look like failures during the apps/web fast gates but are not.

1. `npx eslint lib/<domain>/<file>.ts` prints `warning File ignored because
   no matching configuration was supplied` (0 errors). This is baseline for
   every plain `.ts` under `lib/` (verified against `lib/marketplace/safe-text.ts`),
   not a sign your file is misplaced. `npm run lint` (`eslint .`) still passes.
2. In a worktree shared by parallel builders, `npx vitest` can fail with
   `Cannot find package 'vitest'` because a sibling agent's `npm ci` is still
   running. `pgrep -f "npm ci"` shows it; wait for it to exit, never start a
   second install into the same `node_modules`.

3. `npm run test:unit -- convex/foo` does NOT run a targeted subset. The
   script is `vitest run ... && node scripts/verify-test-completeness.mjs`, so
   the appended args land on the completeness script and vitest runs the
   whole suite (~90s). For a fast targeted loop use `npx vitest run
   convex/foo` directly; the completeness check only passes on the full run.
4. `apps/web/link-deps.sh` compares the repo ROOT (first `git worktree list`
   entry) to `apps/web`, so it always reports "Primary checkout has no
   node_modules" in the monorepo layout. Symlink by hand to a sibling's
   `apps/web/node_modules` whose `package-lock.json` is byte-identical — and
   prefer a recently installed worktree over `main/`, whose node_modules can be
   stale against its own lockfile (a missing eslint plugin made `npm run lint`
   crash with ERR_MODULE_NOT_FOUND on NEO-281). `node_modules` is gitignored,
   so the symlink never reaches a commit.

**Why:** items 1-2 cost a round of head-scratching on NEO-278, items 3-4 on
NEO-281, before the gates went green; none is a bug in the change.

**How to apply:** when a gate errors before it runs any tests, check for a
concurrent install first; when eslint warns "ignored" on a lib `.ts`, run the
whole `npm run lint` instead of per-file for the real verdict.
