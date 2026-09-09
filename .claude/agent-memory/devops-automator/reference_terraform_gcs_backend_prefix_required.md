---
name: reference-terraform-gcs-backend-prefix-required
description: terraform init needs -backend-config="prefix=terraform/state/<env>" — a bare init reads an empty root prefix and the plan shows dozens of phantom "to add" resources
metadata:
  type: reference
---

# terraform init requires an explicit -backend-config prefix per environment

`main.tf`'s `backend "gcs"` block declares only the state bucket
(`neonbinder-terraform-state-prod`) — the per-environment key is deliberately
left out of the file and must be supplied at init time:

```bash
terraform init -backend-config="prefix=terraform/state/dev"   # or .../prod
```

This matches `.github/workflows/terraform.yml`'s `STATE_PREFIX` env var
(`terraform/state/dev` for the dev job, `terraform/state/prod` for prod).

**Trap:** running plain `terraform init` (no `-backend-config`) succeeds
silently and inits against the bucket's *root* prefix, which is empty/
unrelated to either real environment's state. A `terraform plan` from that
init looks alarming — dozens of resources show as "to add" that are actually
long-since-provisioned (e.g. one run showed "87 to add, 0 to change" for a
change that should have been "14 to add, 1 to change, 1 to destroy" per an
already-known-good plan). It's not a sign the config is broken; it's a sign
you're reading the wrong state. Re-run `terraform init -reconfigure
-backend-config="prefix=terraform/state/<env>"` and the plan drops to the
expected size.

Switching from dev's prefix to prod's (or back) also requires `-reconfigure`
(or a fresh dir) since Terraform won't silently swap backend config between
runs.
