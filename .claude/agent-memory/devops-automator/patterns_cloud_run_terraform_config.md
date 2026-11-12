---
name: patterns-cloud-run-terraform-config
description: Cloud Run config in Terraform — validate-only API to test a setting without creating anything, gen2 via annotation on google ~>4, and env vars that a deploy lane removes
metadata:
  type: reference
---

# Cloud Run config patterns (google ~> 4, `google_cloud_run_service`)

- **Test whether the API accepts a setting before an apply:** POST a
  throwaway service to the v2 API with `validateOnly=true`
  (`.../v2/projects/<p>/locations/<r>/services?serviceId=<throwaway>&validateOnly=true`)
  and a public image such as `us-docker.pkg.dev/cloudrun/container/hello`.
  Nothing is created. Include a deliberately invalid control (startup probe
  period 300 is rejected: "period_seconds must be a number between 0 and
  240") to prove validation is running. Validate-only accepted startup
  `failureThreshold` 300 and even 1000 at period 2, so it does not prove a
  ceiling, only that a value is not rejected up front.
- **gen2 / cpu boost:** the v1 resource has no `execution_environment` field.
  Use template annotations `run.googleapis.com/execution-environment = "gen2"`
  and `run.googleapis.com/startup-cpu-boost = "false"`. gcloud's
  `--no-cpu-boost` writes the latter, so if it is undeclared every plan
  shows it as drift.
- **An env var that a deploy lane REMOVES must be a `dynamic "env"` block**
  emitted only where it applies, never `value = ""` elsewhere. Otherwise the
  lane's `--remove-env-vars` and Terraform fight: drift on every plan and a
  re-add on every apply. The env list is diffed like a set, so adding one var
  also shows neighbouring secret-ref vars as remove/re-add (cosmetic); see
  [[reference-cloud-run-env-ordered-list-diffing]].
- **A template change with `traffic` in `ignore_changes`** creates a new
  revision that gets no traffic (the PUT carries live traffic, which pins the
  old revision). Cloud Run still starts it once to check readiness, so the
  startup probe budget must fit whatever image is live at apply time. The
  change reaches serving on the next deploy, because gcloud deploy starts
  from the service template.
