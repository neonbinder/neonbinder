---
name: eslint-flat-config-skips-ts
description: apps/web ESLint lints .tsx (react-hooks + the NEO-44 raw-input rule) but still NOT plain .ts — a .ts file reports "File ignored because no matching configuration was supplied" and exits 0
metadata:
  type: project
---

`apps/web/eslint.config.mjs` scopes every rule block to
`**/*.{js,mjs,cjs,jsx,tsx}` (react-hooks) or `**/*.tsx` (parser + the NEO-44
`no-restricted-syntax` raw `<input>`/`<textarea>` rule). Nothing names `.ts`, and
flat config only visits `.js`/`.mjs`/`.cjs` by default — so **plain `.ts` source
is silently skipped**: `npx eslint some-file.ts` prints "File ignored because no
matching configuration was supplied" and exits 0, and `--print-config` on it
returns `undefined`.

**Why it matters:** a green `ESLint (apps/web)` check says nothing about
`convex/**`, `lib/**`, `src/hooks/*.ts`, or any non-JSX module. `.tsx` coverage
is real (verified 2026-08-18: `--print-config` on an app page returns the
react-hooks rule set), so that half of the old "lint is a no-op" story is fixed —
NEO-44b widened react-hooks to `.tsx`, which is why the config comment mentions
~53 latent errors and NEO-111.

**How to apply:** for a `.ts`-only change, lint proves nothing — lean on
`npx tsc --noEmit -p tsconfig.json` (note: it already reports pre-existing errors
in `convex/*.test.ts` when codegen is stale, plus `vite.config.ts`; compare
against those rather than expecting zero). Adding `.ts` to the globs is its own
scoped task, not a drive-by.

Related: [[vercel-build-runs-convex-typecheck]], [[convex-codegen-only-blocks-types]].
