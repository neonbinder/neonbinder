---
name: patterns-merge-queue-cheap-full-split
description: Auditing a cheap-PR / full-merge_group CI split — stale cheap greens after rollback, merge_group drops the fork/Dependabot secret boundary, eject classifier vs auto re-enqueue, dequeue teardown racing a re-enqueue
metadata:
  type: project
---

Review rules from NEO-546 (GitHub merge queue behind a repo variable; the PR run is cheap, the merge_group run is full).

**1. A cheap green outlives the mode that made it safe.** The cheap-mode required check is a green check run on the PR head SHA. Remove the merge_queue rule (rollback) and that green satisfies the plain ruleset, so `gh pr merge` merges directly on cheap checks. Fail-closed logic in the mode script cannot help: it ran in the past. Fix where the merge happens: the merge skill re-reads the live rules before merging, a non-queue merge requires proof the head SHA's gate ran FULL (an E2E check run exists, or the gate log says mode=full), and the rollback runbook re-runs CI on every open PR.

**2. "Queue live" must mean "queue live AND the gate is required in it".** Checking only that a `merge_queue` rule exists lets a ruleset with the queue but no required `CI Gate` (or the check pinned to the wrong app) turn PR runs cheap while the queue merges on nothing. The mode script should also require `required_status_checks` to contain the gate context, with the Actions app integration id.

**3. merge_group runs in base-repo context: full secrets and id-token for ANY enqueued PR**, fork and Dependabot included. A `pull_request` from a fork gets neither; a Dependabot `pull_request` gets only Dependabot secrets. Any `head.repo.full_name == github.repository` guard that is ORed with `event_name == 'merge_group'` deletes the fork boundary, and `head_repository` filters on cross-run artifact reads stop excluding fork content (a merge_group run's head repo is always the base repo). WIF conditions admitting `merge_group` are no wider than dev `pull_request` for same-repo code, but they newly admit fork and Dependabot code. Fix: the mode script fails a merge_group whose PR is from a fork or authored by dependabot[bot] (exit 1 before any secret-using job, since every such job `needs:` it). This is effective for Dependabot, whose PRs never edit CI. For forks it is only partial, because the fork's diff can delete the check. So the merge skills must also refuse to enqueue either kind.

**4. The required gate is PR-controlled code on both events.** On `pull_request` and on `merge_group` alike, the gate script comes from the PR or merge content. A PR can always neuter its own gate, so the real control is human review before enqueue. Do not grade this as new when it is unchanged; say so.

**5. Eject classifier feeding an auto re-enqueue.** When "enqueue = merge approval" and EJECTED triggers fix/re-enqueue, a manual dequeue misread as EJECTED re-merges something a human pulled. Treat unknown reasons as REMOVED (stop and ask), not EJECTED. The workflow-side notifier can default the other way, because a spurious ping is cheap.

**6. Dequeue teardown races the re-enqueue.** A `dequeued` handler that cancels "this PR's queued/in_progress merge_group runs" and tears down pr-N previews will hit a fast re-enqueue's new group. It must bound both actions by time (runs created before the dequeue) or by the group SHA. The skill should wait for the cleanup run before re-enqueueing.

**7. Comments that claim "this job runs no PR code" on a `pull_request` workflow are false.** The YAML itself comes from the merge ref. A default-branch checkout only protects the scripts it loads. Flag the comment so nobody later adds privilege on the strength of it.

**8. Delta-round traps (fix review).**
- "Proof the SHA ran full" must name the check that is the VERDICT, not a report. In this repo the JUnit-publish check is informational (green on a partial run: a dead shard just means fewer tests); the gate job inside the E2E workflow is the verdict. Query it by exact name with `check_name=` and `filter=latest`, since the check-runs list is paginated (30) and holds every rerun.
- A skill-side "is the queue live" check must be the SAME predicate as the CI mode script (queue rule AND the gate required, pinned to the Actions app), or the two drift exactly where the original finding lived.
- An "or <carve-out>" escape in a merge-proof rule (e.g. a deps-only path that only Dependabot PRs can take, which are never merged) is an unverifiable bypass. Delete it.
- A re-enqueue path written as a bare `gh pr merge` in a later step skips the pre-enqueue checks listed in an earlier step. Every enqueue path should point back to the full checklist.
- Workflow-level `concurrency` with `cancel-in-progress: false` keeps only ONE pending run per group. A no-op event (e.g. a dequeue-on-merge) arriving after a pending `closed` replaces it, and the teardown is lost. Put the group on the teardown job(s) instead, one group per job, so no-op runs never enter it.
- "Unknown → skip teardown" is acceptable when a later event (close) always tears down regardless. It needs a visible warning, because a systematic read failure (token scope) turns it into a silent leak on every dequeue.

Related: [[patterns-preview-cleanup-blast-radius]], [[patterns-cross-run-artifacts]], [[patterns-ci-cross-run-queue]].
