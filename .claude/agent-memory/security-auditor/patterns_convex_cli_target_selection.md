---
name: patterns-convex-cli-target-selection
description: Any shell wrapper around `npx convex run/env` that guards on a deployment NAME is bypassable — CONVEX_DEPLOY_KEY is read first and wins; how to audit those guards and how to refuse a prod key
metadata:
  type: project
---

Scripts that wrap `npx convex …` and promise "this can never target
production" (e.g. `apps/web/e2e-baseline.sh`) are the pattern to audit here.
Almost all of them guard on a deployment **name** they resolved themselves.
That guard is incomplete.

**Verified against the CLI bundle** (`apps/web/node_modules/convex/dist/cli.bundle.cjs`,
convex 1.45.0 — re-verify if the pin moves):

- `getDeploymentSelectionFromEnv` reads `CONVEX_DEPLOY_KEY` **first** and
  returns immediately. `CONVEX_DEPLOYMENT` from `.env.local` / `.env.convex`
  is only consulted when no key is present. The CLI's own help text: "When
  `CONVEX_DEPLOY_KEY` environment variable is set (typical in CI), it is the
  deployment associated with that key."
- The CLI runs `dotenv.config({path: ENV_VAR_FILE_PATH}); dotenv.config();`
  itself, so a `CONVEX_DEPLOY_KEY` sitting in `.env.local` or `.env` counts
  as "set" even if the wrapper never exported it.
- Key shapes (`isPreviewDeployKey` / `isProjectKey` / `isDeploymentKey`):
  `prod:<name>|…`, `dev:<name>|…`, `preview:<team>:<project>|…`,
  `project:<…>|…`. A **preview key is team+project scoped, not
  deployment-scoped** — it reaches any preview in the project, so a wrong
  deployment name lands on another PR's preview (CI-integrity, not prod).
- `_getDeploymentSelection` returns early for `--deployment <bare-name>`
  (`kind: "deploymentWithinProject"`) **before** looking at the deploy key —
  so when `--deployment` is passed the key is NOT a backstop; the name is the
  only thing selecting the target. Conversely `--prod` / `--deployment-name`
  combined with a key logs "Ignoring … using deployment from
  CONVEX_DEPLOY_KEY", and `--deployment` + a key-sourced selection crashes
  with "The `--deployment` flag cannot be used with CONVEX_DEPLOY_KEY".

**How to apply.** When a wrapper resolves a target and refuses prod:

1. Check whether it inspects `CONVEX_DEPLOY_KEY` (env AND `.env.local`). If
   not, the no-flag path is a prod hole: it prints a dev slug and runs against
   whatever the key names.
2. The fix is a prefix check, never echoing the value:
   refuse `prod:*` and `project:*`, and refuse any key whose text contains the
   prod slug. Optionally require an explicit `--deployment` whenever a key is
   present, since the printed target is otherwise a lie.
3. Prefer a substring/glob match (`case "$X" in *"$PROD"*)`) over `=` — the
   CLI accepts URL and `team:project:name` selector forms an exact compare
   misses.
4. `[ -z "${CI:-}" ]` is a weak "am I interactive" test — `CI=true` is
   commonly exported in local shells. Use `${GITHUB_ACTIONS:-}` for a
   GH-Actions-only bypass.

Related: [[patterns_testing_endpoint_gate]] (env-gated runner endpoints),
[[patterns_convex_auth_boundary]] (the in-Convex half of the boundary; a
`requireAdmin` batch mutation is defence-in-depth, the deploy credential is
the real gate).
