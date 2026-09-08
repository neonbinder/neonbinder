---
name: patterns_convex_cli_gotchas
description: Convex CLI operational gotchas found while building NEO-214's scripted admin tasks — env-default secret exposure, preview-deployment default env vars, and CI hermeticity for ad-hoc `npx convex` calls
metadata:
  type: reference
---

## `npx convex env list` / `env default list` prints raw secret VALUES

Running either without `--names-only` dumps every value in plaintext to
stdout — including the deployment's service-account keys and auth secrets.
Discovered the hard way running `npx convex env default list` during NEO-214
— it landed the whole set in agent context.

**Always pass `--names-only`** for `env list` / `env default list` unless you
specifically intend to capture a value, and even then prefer `env get
<NAME>` / `env default get <NAME>` for a single variable over a full list.

## Convex "preview deployment defaults" (`npx convex env default`)

`npx convex env default {set,get,list,remove} [--type dev|preview|prod]`
manages **project-level default env vars per deployment type** — these are
what a freshly created deployment of that type starts with. This is *why*
E2E_QUEUE_SECRET, ALLOW_RESET_SET_BUILDER_DATA, NEONBINDER_BROWSER_URL etc.
already work on every brand-new per-PR Convex preview without any CI step
ever setting them: they're `--type preview` defaults, configured once
(likely via the dashboard originally, readable/writable via this CLI
subcommand). `--type prod` defaults are nearly empty by design (prod is a
fixed deployment, rarely recreated).

Without `--type`, the command operates on the type of your **current**
deployment (usually `dev` from `.env.local` in `apps/web`) — easy to
misread as "the project's defaults" when it's actually just the dev-type
slice. Use `--names-only` here too (see above).

## `npx convex run` flag surface is stable across versions in this repo's range

Verified 2026-09-04: `--deployment`, `--identity`, `--typecheck`,
`--codegen`, `--prod` all exist identically in convex@1.39.1 (pinned by
`pr-pipeline.yml`'s ad-hoc CLI calls) and convex@1.45.0 (apps/web's installed
`^1.44.0`). Safe to pin either for a new ad-hoc CLI invocation without a
flag-availability risk.

## CI jobs that only run Maestro never `npm ci` apps/web

`.github/actions/maestro-runner` (used by `e2e.yml`'s `seed` and runner
jobs) installs Java/Chrome/Maestro/Xvfb only — no Node package install,
since driving Maestro + calling `run-e2e-smoke.sh` needs no node_modules.
Any script that job runs and that shells out to `npx <pkg>` therefore has
**no local install to resolve** — use `npx --yes <pkg>@<pinned-version>`
(matches `pr-pipeline.yml`'s existing `npx --yes convex@1.39.1 …` pattern),
never a bare `npx convex`. A maintainer's local shell in `apps/web` *does*
have node_modules, but pinning the same hermetic version there too avoids
CI/local drift — see `apps/web/e2e-baseline.sh`.

## Prod deployment identity

Scripts that must refuse to touch prod need the prod deployment name as a
hardcoded refusal target — the CLI offers no dynamic "this is prod" signal the
way `--prod` does, and `--deployment <prod-name>` bypasses `--prod`'s own
guard. The name itself is operational detail: it lives in the private
operational notes, not here.
