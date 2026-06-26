# Monorepo cutover runbook (NEO-18)

This repo (`neonbinder/neonbinder`, **private**) is the consolidated monorepo built from
`neonbinder_web` (→ `apps/web`) and `neonbinder_browser` (→ `services/browser`). It was
created as a **fresh squashed start** (no history). This runbook covers what's left to make
it the production source of truth. **None of this has touched production** — the old repos +
their Vercel/Convex/Cloud Run pipelines are untouched and remain the live system until cutover.

## What already works (built overnight)

- **Repo + unified CI pushed.** `web-ci.yml` (vitest+eslint) and `browser.yml` (build+unit) are
  green. `e2e.yml` (Maestro suite) runs against the **dev browser service** via the Convex
  preview default — no cross-repo dispatch, no `integration-test` branch, no `convex-dev-gate`,
  no dispatch token.
- **Secrets set** on the repo (marketplace, Vercel, testing, queue, GCP identifiers).
- **Vercel project** `neonbinder` linked, Root Directory `apps/web` (fixed a leading-space typo),
  env vars cloned. Preview builds succeed.

## ⚠️ Do these when you're back (small)

1. **Delete the local secret files** you staged: `rm /Users/jburich/workspace/neonbinder/.mono-secrets.env /Users/jburich/workspace/neonbinder/neonbinder_web/.env.vercel.*` (they're plaintext secrets; already gitignored, never committed).
2. **Redeploy `main` on Vercel** — the first production deploy errored (the leading-space Root Directory, now fixed). Trigger a redeploy from the Vercel dashboard or push any commit to `main`.
3. **Apply the GCP WIF change** below — only needed once you want the **browser deploy pipeline / per-PR browser preview** (step C). Not needed for the E2E green path (which uses dev browser).

## GCP WIF terraform change (for the browser pipeline)

The browser deploy + per-PR Cloud Run preview authenticate via WIF, which today only trusts
`neonbinder/neonbinder_browser` (`var.github_repo`). Extend it to also trust the monorepo.
**Transitional** (keeps the old repo working too; tighten to just the monorepo once the old repo
is archived). In `neonbinder_terraform/`:

```hcl
# variables.tf — add:
variable "github_repo_monorepo" {
  description = "Consolidated NEO-18 monorepo allowed to authenticate via WIF"
  type        = string
  default     = "neonbinder/neonbinder"
}

# main.tf — google_iam_workload_identity_pool_provider.github: widen attribute_condition
#   from:  assertion.repository == "${var.github_repo}" && (...)
#   to:    (assertion.repository == "${var.github_repo}" || assertion.repository == "${var.github_repo_monorepo}") && (...)
# (apply to BOTH branches of the browser_wif_allow_pull_requests ternary)

# main.tf — add a second binding alongside google_service_account_iam_member.github_actions_wif:
resource "google_service_account_iam_member" "github_actions_wif_monorepo" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_actions.name}/attribute.repository/${var.github_repo_monorepo}"
}
```

Then `terraform plan`/`apply` against **dev** (per `reference_terraform_local_apply`). The
`GCP_WIF_PROVIDER_DEV` / `GCP_SERVICE_ACCOUNT_DEPLOYER_DEV` secret values stay identical (same
provider + SA) — already set on the repo (verify they're correct; they were reconstructed:
provider `projects/339836466983/locations/global/workloadIdentityPools/github-actions/providers/github`,
SA `neonbinder-browser-deployer@neonbinder-dev.iam.gserviceaccount.com`).

## Cutover steps (when ready to make the monorepo primary)

**A. Branch protection** on `neonbinder/neonbinder` `main` — required checks: `Web CI` (unit+lint),
the `e2e` gate, `Browser CI`. Strict (up-to-date).

**B. Full browser deploy pipeline** — port the rest of `neonbinder_browser/browser-deploy.yml`
into `browser.yml`: `deploy-preview` (per-PR `pr-N` Cloud Run), `preview-login-probe`, `build-push`
(NEO-66 promote-no-rebuild), `deploy-dev`/`dev-promote` (NEO-34 no-rollback), `deploy-prod`.
**Drop `convex-dev-gate` entirely** (the E2E is now the pre-merge gate, not a post-merge dispatch).
Requires the WIF change above.

**C. Per-PR browser preview + key-less browser URL** — the clean wiring you asked for: an
`apps/web/scripts/vercel-build.sh` that, on PR preview builds, computes the deterministic browser
preview URL `https://pr-<N>---neonbinder-browser-xxlo66yxuq-uc.a.run.app` from `VERCEL_GIT_PULL_REQUEST_ID`
and sets `NEONBINDER_BROWSER_URL` on the preview using the Convex deploy key the build already has
(no separate `CONVEX_E2E_PREVIEW_KEY`, no `browser-override` job, no GCP discovery). Gate it so
non-PR/prod builds keep the dev default. This replaces "E2E uses dev browser" with "E2E uses the
PR's own browser preview" for browser-changing PRs.

**D. Re-point production** — switch the live Vercel production project + Convex prod deploy +
Cloud Run prod to deploy from `neonbinder/neonbinder` `main`. Needs `CONVEX_PRODUCTION_DEPLOY_KEY`
+ prod GCP secrets (`GCP_WIF_PROVIDER`, `GCP_SERVICE_ACCOUNT_DEPLOYER`) set on the repo. Do this in
a quiet window (deploy freeze).

**E. Decommission** — archive `neonbinder_web`/`neonbinder_convex` and `neonbinder_browser` (don't
delete — keep as fallback). Then tighten the WIF condition to drop the old `var.github_repo`.

## Deferred follow-ups

- Lift the remaining workflows: `codeql.yml`, `claude-review.yml` (needs `ANTHROPIC_API_KEY`),
  `preview-cleanup.yml`, `e2e-repeat.yml`, `refresh-flow-timings.yml`.
- **Rewrite `CLAUDE.md`** for the monorepo (it still says "NOT a monorepo" + per-repo commit rules).
- Fix the E2E `report` job + artifact paths for the monorepo (`working-directory` vs `uses:` path
  mismatch — non-blocking; the `e2e` gate reads the Convex queue, not artifacts).
- **Public-with-scrub** decision (if you want free CI again): redact infra IDs in `CLAUDE.md`/`todos/`,
  omit `todos/overnight-2026-05-27-pr39-green.md` (CI-leak disclosure) + the credential-architecture
  memory, then flip public.
- Optional `packages/contract` for the browser-service **wire types only** (NOT the adapter layers —
  those are a deliberate FE→Convex→browser security boundary; see memory).
