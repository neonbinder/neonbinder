# Terraform: bring Vercel + GitHub under IaC

`neonbinder_terraform/` today is GCP-only. Everything Vercel / GitHub
below is live in the respective dashboards/APIs but not in code. Long-
term goal: declare all of it in Terraform so rebuilds are reproducible
and drift is visible. Matches the "never provision outside Terraform"
rule in Claude memory.

This list reflects what's known **as of 2026-04-17** and is expected to
drift before we actually do the work. Re-scan before starting.

## Providers we'll need

- `vercel/vercel` — env vars, protection bypass, domain mappings, project settings
- `integrations/github` (terraform) — repo secrets, rulesets, App installs where applicable

Both need a token — likely stored in GCP Secret Manager, loaded via
a data source in the TF backend init.

## Vercel (project: `neon-binder/neonbinder_web`)

### Env vars — preview + development scoped
Roughly 25+ env vars across `VITE_*`, `CLERK_*`, `NEXT_PUBLIC_CLERK_*`,
`CONVEX_*`, `BLOB_READ_WRITE_TOKEN`, `ENCRYPTION_KEY`, `TEST_EMAIL`,
`TESTING_ENDPOINT_SECRET`, `VITE_TESTING_ENDPOINT_SECRET`, etc. Export
current state with `vercel env pull` per env before writing TF.

Known scoping rules to preserve:
- `CLERK_SECRET_KEY`, `TESTING_ENDPOINT_SECRET`, `VITE_TESTING_ENDPOINT_SECRET`,
  `TEST_EMAIL`, `CLERK_TESTING_ENABLED` → **Preview + Development only**, never Production.
- `NEXT_PUBLIC_*` and some `VITE_*` that are public → Production, Preview, Development.

### Other project settings
- Deployment Protection: "Standard Protection" (Vercel SSO)
- **Protection Bypass for Automation**: secret generated 2026-04-17, also
  stored as GitHub repo secret `VERCEL_AUTOMATION_BYPASS_SECRET`.
- Framework preset (currently `next.js` in dashboard despite the app being
  Vite; something to reconcile — `vercel.json` says `vite`)
- Rewrites: already in `vercel.json` (already code, nothing to Terraform).

## GitHub — repo-level config not in code

### `neonbinder/neonbinder_convex`

Repo secrets (for E2E + deploys):
- `MAESTRO_SPORTLOTS_USERNAME`, `MAESTRO_SPORTLOTS_PASSWORD`
- `MAESTRO_BSC_USERNAME`, `MAESTRO_BSC_PASSWORD`
- `MAESTRO_TEST_EMAIL`, `MAESTRO_TEST_PASSWORD` (pre-existing)
- `TESTING_ENDPOINT_SECRET`
- `VERCEL_AUTOMATION_BYPASS_SECRET`
- `CONVEX_PREVIEW_DEPLOY_KEY`, `CONVEX_PRODUCTION_DEPLOY_KEY` (pre-existing)
- `VERCEL_TOKEN` (pre-existing, used by Vercel integration)

Rulesets:
- "production" (id 12335663) on default branch — enforces PR, no deletion,
  no fast-forward, and required status check `e2e` (added 2026-04-17).

### `neonbinder/neonbinder_browser`

Repo secrets:
- `GCP_WIF_PROVIDER`, `GCP_WIF_PROVIDER_DEV`
- `GCP_SERVICE_ACCOUNT_DEPLOYER`, `GCP_SERVICE_ACCOUNT_DEPLOYER_DEV`

Rulesets:
- "Main PR" — PR required, code_scanning, code_quality, required_linear_history,
  no deletion, no force-push. (Used to require `copilot_code_review`; we
  removed that rule during the GCP migration to unblock a merge.)

### `neonbinder/neonbinder_ioc` (terraform repo)

Repo secrets:
- `GCP_WIF_PROVIDER_TF`, `GCP_WIF_PROVIDER_TF_DEV`
- `GCP_TF_SERVICE_ACCOUNT`, `GCP_TF_SERVICE_ACCOUNT_DEV`

No ruleset yet (verify when getting to this).

### `neonbinder/neonbinder_preprocess`

Repo secrets:
- `GCP_WIF_PROVIDER_PREPROCESS`, `GCP_WIF_PROVIDER_PREPROCESS_DEV`
- `GCP_SA_PREPROCESS_DEPLOYER`, `GCP_SA_PREPROCESS_DEPLOYER_DEV`

Rulesets: TBD.

## Claude Code GitHub App

Installed on `neonbinder_convex` (and possibly others). The install
itself is account-level and isn't typically Terraformed, but the
workflow file that invokes it IS in code (`claude-review.yml` on
`neonbinder_browser`). If we add the workflow to more repos, they need
the App installed on each.

## When we do this

Suggested ordering to keep each step reviewable:
1. Stand up the `vercel/vercel` provider in `neonbinder_terraform/` and
   import the existing preview env vars on `neonbinder_web`. Get a clean
   plan before touching anything else.
2. Add the `github` provider. Import the four repos' secrets + rulesets.
3. Add `github_app_installation_repositories` or similar for the Claude App.
4. Remove the one-off `scripts/` or manual notes that remain.

## What's intentionally out of scope (for now)

- Org-level GitHub settings (team membership, billing, branch default)
- Vercel team/account settings
- DNS records (Cloudflare or wherever `neonbinder.io` zones live)
