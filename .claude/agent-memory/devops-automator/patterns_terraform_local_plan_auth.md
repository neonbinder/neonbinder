---
name: patterns-terraform-local-plan-auth
description: Local read-only terraform plan when ADC fails with invalid_rapt, and the fix for the prod plan's billing-budget 403 — no -target needed
metadata:
  type: reference
---

# Local terraform plan: auth workarounds (neonbinder_ioc)

- **ADC expired (`invalid_grant ... invalid_rapt`) but `gcloud` CLI still works:**
  export `GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token)` before
  `terraform init` and `terraform plan`. Both the gcs backend and the google
  providers honour it. No browser login needed while the CLI token is valid.
- **Prod plan 403 on `google_billing_budget` ("requires a quota project"):**
  run the plan with `USER_PROJECT_OVERRIDE=true GOOGLE_BILLING_PROJECT=<the prod
  project id>`. The full prod plan then works; `-target` is no longer needed.
- Use `-lock=false` for a read-only plan so a local plan never holds the state
  lock against a CI run.
- Switching env still needs `terraform init -reconfigure -backend-config=prefix=...`
  (see [[reference-terraform-gcs-backend-prefix-required]]).
- `terraform fmt` without `-recursive` skips `environments/*.tfvars`; run
  `terraform fmt -check -recursive` before committing.
