---
name: patterns-ar-cleanup-serving-image
description: Availability invariant for the Artifact Registry cleanup policies in terraform main.tf — when a KEEP rank guard actually protects the live serving image and when it silently does not
metadata:
  type: project
---

# AR cleanup policies: the "two independent guards" invariant

`google_artifact_registry_repository.gcr_io` in `terraform/main.tf` guards
each service's images with a pair: a KEEP policy (`most_recent_versions`, keep_count N,
package-scoped) and a DELETE policy (TAGGED, `older_than` 14d, package-scoped). KEEP wins
over DELETE, so a version dies only if it is BOTH older than the age gate AND outside the
newest N. Every Cloud Run revision is `minScale=0`, so collecting the digest a live
revision pins does not degrade — the next request cold-starts against a missing image and
100% of requests fail. Cloud Run cannot self-heal: revisions are immutable.

**The invariant that makes this safe is NOT "N is big enough". It is that the two guards
fail in opposite conditions.** The age gate protects fast-deploying environments (serving
image is always young); the rank guard protects slow-deploying ones (serving image is
always near rank 1). It breaks for any service where BOTH can be true at once.

**Why rank ≠ deploy count.** PR previews push `pr-<N>` into the *same* package as
main-line images (`neonbinder-browser`, `neonbinder-preprocess` — verified in both
workflows). Re-pushing a `pr-N` tag creates a new version and untags the predecessor, and
`most_recent_versions` has no tag_state filter, so untagged leftovers occupy keep slots
too until `delete-old-untagged` reaps them at 14d. Measured 2026-08-08 on dev
`neonbinder-browser`: 6 of the 10 protected slots were `pr-*` or untagged preview
leftovers, and the whole keep-10 window spanned only 9 days.

**How to audit a proposed change here.** For each package and each env, ask:
1. What is the real merge cadence for that service's paths filter? If the max gap between
   deploys exceeds `older_than`, the age gate is inert and rank is the ONLY guard.
2. What pushes into that package *besides* deploys? Preview churn consumes rank without
   refreshing the serving image's age.
3. Does prod receive preview pushes? (Today: no — `PROD_IMAGE` is written only by the
   push-to-main lane, and each push promotes, so prod rank stays ~1.)

Verify with `gcloud artifacts docker images list us-docker.pkg.dev/<project>/gcr.io/<pkg>
--include-tags --sort-by=~createTime` and `gcloud run revisions list --format=...
status.imageDigest` — never from the file's comments alone, which have gone stale before.

Related: [[patterns_preview_cleanup_blast_radius]].
