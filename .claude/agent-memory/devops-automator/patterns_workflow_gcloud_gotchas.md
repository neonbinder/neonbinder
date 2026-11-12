---
name: patterns-workflow-gcloud-gotchas
description: Workflow/gcloud traps found building NEO-484's deploy checks - deploy-cloudrun merges env, checkout after auth deletes the creds file, logging --freshness ignored when ascending, gcr.io listing path, OCI index children
metadata:
  type: reference
---

- **`deploy-cloudrun` env_vars MERGE** (default `env_vars_update_strategy: merge`
  -> `--update-env-vars`). Every var on the service template carries over,
  including one a different lane's deploy left (a preview's `PREVIEW_SHA`
  ended up on serving dev). A var a lane must not have needs
  `--remove-env-vars=X` in `flags`; gcloud allows only update+remove together
  and applies remove first. Then assert the revision's env after the deploy.
- **`actions/checkout` after `google-github-actions/auth` breaks gcloud**:
  checkout's `git clean -ffdx` deletes the `gha-creds-*.json` the auth action
  wrote into the workspace. In a gcloud-only job that needs a repo script, put
  a `sparse-checkout` step FIRST.
- **`gcloud logging read --freshness` is ignored with `--order=asc`** (it only
  applies to descending reads): an ascending read scans all retention. Put
  `timestamp>="..."` in the filter instead.
- **gcr.io images in Artifact Registry**: `gcloud artifacts docker images
  describe gcr.io/P/pkg@sha` works, but `images list` needs the
  `us-docker.pkg.dev/P/gcr.io/pkg` form. `describe --format=json` gives
  `image_summary.fully_qualified_digest`, the easy way to get that path.
- **OCI index children**: list them with the registry API,
  `GET https://<host>/v2/<path>/manifests/<index digest>` with
  `Authorization: Bearer $(gcloud auth print-access-token)` and an index
  `Accept`. Pass the header via `curl -H @-` on stdin so the token stays out
  of argv. Config labels: `.config.digest` from the manifest, then
  `GET .../blobs/<digest>` with `-L` (redirects to storage).
- No local `docker` on the Mac: test registry predicates (single manifest vs
  index) with curl against real tags instead of `docker buildx imagetools`.

Related: [[patterns-cloud-run-terraform-config]], [[reference-cloud-run-env-ordered-list-diffing]].
