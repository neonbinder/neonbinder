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
