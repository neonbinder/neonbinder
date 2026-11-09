---
name: reference-typecheck-convex-changes
description: How to typecheck apps/web/convex changes — which tsconfig matters, the known-failing baseline, and getting deps into a fresh worktree
metadata:
  type: reference
---

Typechecking Convex changes in `apps/web`:

- **The check that matters** is `./node_modules/.bin/tsc --noEmit -p convex/tsconfig.json`. This is what `convex deploy` runs. It must exit 0. It excludes `./_generated` and `./**/*.test.ts` (see the long comment inside that tsconfig for why — test-file typing degradation was silently failing deploys).
- **`tsc -p tsconfig.json` (the app config) has a pre-existing non-zero baseline** — see [[apps-web-root-tsc-is-not-a-gate]] for the current count and how to diff against it. Do NOT treat those as regressions.
- `convex/_generated/dataModel.d.ts` derives types straight from `../schema.js` via `DataModelFromSchemaDefinition`, so **new tables/indexes typecheck without running codegen or `convex dev`.**
- `eslint` has no config covering `convex/**` — it reports "File ignored because no matching configuration was supplied". Don't chase that warning.

**Fresh git worktrees have no `node_modules`** (there is no root `package.json`/npm workspace — each app installs its own). To typecheck without a multi-minute install, verify `apps/web/package.json` is identical to the main checkout's, then temporarily
`ln -sfn <main-checkout>/apps/web/node_modules node_modules`, run tsc, and `rm -f node_modules` afterward so the worktree is left clean.

See [[feedback-no-local-convex-deploy-from-worktrees]].

`apps/web/link-deps.sh` does not work in a monorepo worktree: it takes the
primary checkout's REPO ROOT (`main/`) and looks for `node_modules` there,
not in `main/apps/web/`, so it always refuses. Do the manual symlink above
(after `cmp` of the two `apps/web/package-lock.json`). With parallel builders
in one worktree, leave the gitignored link for the coordinator to remove
rather than pulling it out from under another agent's gate run.

`apps/web` is **npm** (`package-lock.json`, no `yarn.lock`). A brief that says
`yarn install` is wrong: yarn ignores the lockfile and writes a stray
`yarn.lock`. If no `node_modules` exists and no other agent is using one,
`npm ci --no-audit --no-fund` in `apps/web` took about a minute (2026-11-01).

**A new Convex module needs `_generated/api.d.ts` regenerated** (it is
committed). `dataModel.d.ts` follows the schema on its own, but
`internal.<newModule>.*` exists only once api.d.ts imports the module. The
gates hide the gap from the module's own builder: the convex typecheck
excludes `*.test.ts` and vitest resolves `internal` through a runtime proxy,
so the new file and its test both pass while the first non-test caller (an
adapter scheduling it) fails typecheck. Tell the coordinator to regenerate
api.d.ts once every parallel builder is done, rather than hand-editing a
shared generated file mid-build.

`npm run test:unit`'s completeness check (`verify-test-completeness.mjs`)
fails when another builder creates a `.test.ts` while the suite is running
("exist but reported no result"). With parallel builders, check whether the
listed file is yours before re-running.
