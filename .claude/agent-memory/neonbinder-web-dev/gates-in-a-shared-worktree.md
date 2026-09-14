---
name: gates-in-a-shared-worktree
description: Two apps/web gate quirks — eslint "File ignored" warning on lib/*.ts is baseline, and a fresh worktree's node_modules may be mid-install by a sibling builder (wait, never start a second npm ci)
metadata:
  type: feedback
---

Two things that look like failures during the apps/web fast gates but are not.

1. `npx eslint lib/<domain>/<file>.ts` prints `warning File ignored because
   no matching configuration was supplied` (0 errors). This is baseline for
   every plain `.ts` under `lib/` (verified against `lib/marketplace/safe-text.ts`),
   not a sign your file is misplaced. `npm run lint` (`eslint .`) still passes.
2. In a worktree shared by parallel builders, `npx vitest` can fail with
   `Cannot find package 'vitest'` because a sibling agent's `npm ci` is still
   running. `pgrep -f "npm ci"` shows it; wait for it to exit, never start a
   second install into the same `node_modules`.

**Why:** both cost a round of head-scratching on NEO-278 before the gates went
green; neither is a bug in the change.

**How to apply:** when a gate errors before it runs any tests, check for a
concurrent install first; when eslint warns "ignored" on a lib `.ts`, run the
whole `npm run lint` instead of per-file for the real verdict.
