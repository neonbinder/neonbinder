---
name: patterns-iam-lockdown-and-gcp-limits
description: Durable GCP/Terraform gotchas found while doing an allUsers-removal IAM lock-down (NEO-175 preprocess fast/heavy split) — check CI smoke tests before removing allUsers, GCP SA account_id 30-char cap, google_cloud_run_service env-block ordered-list drift, this repo's local read-only plan setup.
metadata:
  type: project
---

## Before removing `allUsers` invoker from any Cloud Run service, grep the CI workflows, not just the app-layer callers

When a service transitions from `allUsers` + app-layer header check to
Cloud-Run-IAM-only (the NEO-20 browser pattern, later applied to preprocess in
NEO-175), the obvious caller to re-provision is whatever calls it in
production (Convex, minting an OIDC token). **The CI deploy pipeline's
post-deploy smoke tests are an equally real caller and are easy to miss** —
they hit the tagged/no-traffic revision URL directly, often via a plain
`curl`/`pytest` HTTP client with no Google auth at all, relying entirely on
`allUsers` to even reach the app layer. Removing `allUsers` without granting
the CI deployer SA its own `run.invoker` (mirroring the real caller's grant)
breaks every subsequent CI deploy at the smoke-test step with a 403 from
Cloud Run IAM itself — before the app-layer key check even runs, so the app
logs show nothing.

How to check: read the actual `.github/workflows/*.yml` smoke-test steps (not
just assume the terraform's existing IAM bindings are the full caller list).
If the workflow doesn't already mint an ID token for the deployer SA, that's
a **separate** blocking change needed in the app repo alongside the terraform
lock-down — flag it, don't just add the IAM grant and assume the workflow
will use it. In this case (NEO-175) the OIDC-minting workflow code already
existed on an **open, unmerged PR** with a comment explicitly naming the
terraform grant it was waiting on ("Terraform lands a run.invoker binding for
this deployer SA before this deploys") — reading the CI diff turned a
guessed-at gap into a grounded, cited requirement.

## GCP service account `account_id` has a hard 30-character cap

Regex: `^[a-z](?:[-a-z0-9]{4,28}[a-z0-9])$` — i.e. 6-30 chars total, lowercase
+ digits + hyphens, must start with a letter and not end with a hyphen.
`terraform validate` catches this immediately (no credentials needed), but
it's easy to blow past when composing a name from an existing convention
(`neonbinder-preprocess-runtime` is 29 chars; adding one more qualifier like
`-fast-` before `-runtime` pushed `neonbinder-preprocess-fast-runtime` to 34).
Fix by shortening the LAST component, not the prefix (keeps the recognizable
`neonbinder-<service>` stem) — e.g. `-fast-run` instead of `-fast-runtime`
landed at exactly 30. Always run `terraform validate` (works with
`-backend=false`, no GCP creds needed — see
[[patterns_gcs_signed_url_bucket]]) on any new SA name before treating it as
final.

## `google_cloud_run_service`'s `containers[].env` is an ORDERED LIST, not a set/map

The GA (v4, Knative-shaped) `google_cloud_run_service` resource type diffs
`env` blocks positionally. If the LIVE service has an env var that isn't in
the terraform config at all (someone set it out-of-band via `gcloud run
deploy --set-env-vars` or the console), `terraform plan` doesn't just show
"remove that one var" — it shows a cascading remove-then-recreate of every
env block that comes AFTER it in the live ordering, even though semantically
only one variable actually differs. This looks alarming in a plan diff but is
mechanical, not a sign the terraform is wrong. To confirm a puzzling env-block
diff is pre-existing drift rather than something your own change introduced:
`git stash` your changes, re-run `terraform plan` against the unmodified
branch, and see if the same diff appears unprompted. (Found this exact
pattern on `neonbinder-preprocess` in dev: a `GCS_PLACEHOLDER_BUCKET` env var
present in live dev state, absent from `main.tf`, unrelated to the change
being authored — confirmed pre-existing via the stash test before writing it
up as an incidental finding rather than a bug in the new code.)

## This repo's terraform CAN be planned read-only against real state locally

`cd terraform && terraform init -backend-config="prefix=terraform/state/<dev|prod>" -reconfigure`
then `terraform plan -var-file=environments/<env>.tfvars` works with local
the maintainer's own gcloud login (no impersonation needed for plan/read
access to the GCS state bucket + resource state) — confirmed working
2026-08-20 for a full dev plan. A full PROD plan currently 403s on
`google_billing_budget.gcp_spend[0]`'s data read
(`billingbudgets.googleapis.com`, "requires a quota project, which is not set
by default" under local ADC) — pre-existing, unrelated to any specific
change, not something to try to fix. Work around it with `-target=<only the
resources your change touches>` to get a clean targeted plan without hitting
the unrelated resource. `.terraform.lock.hcl` is gitignored in this repo
(confirmed via `.gitignore` lines 41/60) — deleting it locally between
sessions is harmless, `terraform init` regenerates it, and it never shows up
in `git status`.

## When a task says "the app code is already done, on PR #N" — verify against the PUSHED branch, not just belief

Fetched PR #180's actual pushed HEAD and grepped for every symbol the task's
described contract depended on (`PREPROCESS_ROLE`, `FAST_URL`,
`HEAVY_PREPROCESS`) — zero matches, anywhere in the repo, on any pushed
branch. The real code existed, but only as 3 **unpushed, local-only commits**
in a monorepo worktree (`worktrees/<ticket>/`) that happened
to be sitting on the same branch as the open PR, ahead of what GitHub actually
has. Always check local worktrees under `worktrees/` (list
the directory, check `git log origin/<branch>..HEAD` in each) before
concluding a described prerequisite doesn't exist yet — and always report the
push/merge gap explicitly rather than silently authoring against the
described contract as if it were already live. In this case the contract
turned out to be real and precisely specified (down to exact env var names
and a regex) once the right worktree was found, which is what let the
terraform be authored with confidence instead of guesswork.
