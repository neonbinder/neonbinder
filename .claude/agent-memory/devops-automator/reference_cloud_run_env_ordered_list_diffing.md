---
name: reference-cloud-run-env-ordered-list-diffing
description: google_cloud_run_service env blocks diff positionally — append new env vars at the end, and expect remove+recreate churn on adjacent blocks when the live order differs
metadata:
  type: reference
---

# google_cloud_run_service `env` blocks are an ordered list, not a set

Confirmed with the `hashicorp/google` ~>4.0 provider (Cloud Run v1 API,
`google_cloud_run_service` resource): the `containers[].env` blocks inside
`template.spec.containers` diff **positionally**, not by content/name
matching. This has two practical consequences, both observed while fixing
the NEO-175 `GCS_PLACEHOLDER_BUCKET` dev drift (main.tf, `neonbinder_preprocess`
/ `neonbinder_preprocess_fast`):

1. **Appending a new `env{}` block at the same list position an
   out-of-band-set env var already occupies live produces a fully clean,
   zero-diff plan** for that block — not just "no removal," literally no
   diff at all shown for the resource. Someone had added
   `GCS_PLACEHOLDER_BUCKET` to dev's live heavy service via `gcloud`, which
   naturally appends to the end of the list; adding the matching `env{}`
   block after the existing ones in `main.tf` (rather than inserting it
   earlier) matched that live position exactly.
2. **Inserting/adding an env var anywhere in the list forces the
   positionally-adjacent blocks to show as remove+recreate in the plan**,
   even though their values are unchanged — confirmed doing the identical
   append to prod (which never had `GCS_PLACEHOLDER_BUCKET` live at all):
   the plan showed `ANTHROPIC_API_KEY` and `INTERNAL_API_KEY` env blocks as
   `- env {...} + env {...}` pairs with byte-identical `secret_key_ref`
   contents. This is cosmetic/mechanical, not destructive — same secret,
   same key (`"latest"`) — but it does show up as extra "~" churn in the
   plan and is worth calling out explicitly when reporting plan deltas so
   it doesn't get misread as an unintended change.

Practical rule: when adding a new env var to one of these resources, append
it at the end of the `env{}` block sequence in the HCL (matching however an
out-of-band `gcloud` edit would have added it), and don't be surprised if an
environment where the var was never set shows unrelated-looking env block
churn in its plan — that's this list-ordering quirk, not a real conflict.

See also [[reference_terraform_gcs_backend_prefix_required]] for a related
plan-reading trap (wrong backend prefix) hit in the same session.
