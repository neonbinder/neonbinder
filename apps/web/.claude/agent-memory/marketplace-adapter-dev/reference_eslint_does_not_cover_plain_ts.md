---
name: eslint-does-not-cover-plain-ts
description: apps/web `npm run lint` visits no plain `.ts` file, so Convex adapters and lib/ are gated only by tsc + vitest
metadata:
  type: reference
---

`apps/web/eslint.config.mjs` (flat config) names `.js/.mjs/.cjs/.jsx/.tsx` in
its `files` blocks and nothing else. Flat config only visits extensions a
config block explicitly claims, so **every plain `.ts` file — all of
`convex/`, all of `lib/` — is skipped entirely**. Running
`npx eslint convex/adapters/sportlots.ts` reports
`File ignored because no matching configuration was supplied`, not a clean
pass.

Practical consequence for adapter work: the only gates that actually read
adapter code are `npx tsc -p convex/tsconfig.json --noEmit` and vitest. An
`eslint-disable-next-line` comment in a `.ts` adapter is documentation, not
suppression, and a lint-only style rule cannot be relied on to catch anything
there.

The narrow scope is deliberate and tracked: the header comment on
`reactHooksLegacyScope` explains that widening it (NEO-111) surfaces ~53
pre-existing errors that need judgement, so it has been left pinned.

Verified 2026-09-05 on the neo-251 worktree.
