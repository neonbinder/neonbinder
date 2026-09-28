---
name: patterns-neo309-310-ci-notify-and-json-files
description: CI alert side-channel + gcloud-JSON-to-file audit checklist — secret-in-composite-input interpolation, ref_name in run:, nested reusable-workflow permissions, and tests that pin "pre-fix = HEAD" going red on commit
metadata:
  type: project
---

Reusable review rules from auditing a webhook-alert composite action and the revision GC scripts' switch from env-var JSON to temp files.

**Webhook/secret as a composite-action input.** Check EVERY step of the action, not just the POST: a `guard` step doing `[ -z "${{ inputs.<secret> }}" ]` templates the raw secret into the step's script file on disk and into the log header (masked, but only while the value is byte-identical to the registered secret). Fix is `env: X: ${{ inputs.<secret> }}` then `[ -z "$X" ]`. curl error lines (codes 6/22/28, `--retry` warnings) do not print the URL path, so the POST itself is fine when the URL is on argv via env.

**`${{ github.ref_name }}` / `event_name` interpolated into `run:`.** Enumerate the triggers before grading: schedule / push-to-main / workflow_call-from-main / workflow_dispatch (dispatcher already controls the workflow file on that branch) give no escalation today, so it is should-fix hygiene, not a blocker. It becomes live the day someone adds `pull_request` (head_ref) or `pull_request_target`. actionlint does NOT flag `github.ref_name` — grep for it by hand.

**Nested reusable-workflow permissions.** A job inside a `workflow_call` workflow that requests a scope the CALLER's `uses:` job did not grant fails the whole run at startup (not a silent no-op). So adding `actions: read` at the caller is required, and it only reaches nested jobs that request it explicitly (the called workflow's top-level `permissions:` still caps the rest).

**Double alert through `uses:`.** A notify job in the caller (sees `needs.<lane>.result`) plus one in the called deploy workflow both fire on one lane failure. Not a security issue; mention it.

**Env-var → file refactors of a destructive planner.** Diff the Python plan body line by line: only the input read should move. Confirm: the gcloud fetch still aborts before planning (under `set -e`, or `|| exit`), the plan files (`tags.txt`/`revisions.txt`) are written only at the END of the planner so a crash leaves nothing to apply, and the non-zero exit happens before the `--apply` branch. `$?` inside `if ! cmd; then ...` is 0 (the negation), so a "exited $?" message there always lies; inside `x="$(cmd)" || { ... $? }` it is correct.

**Tests that fetch "the pre-fix script" with `git show HEAD:<path>`** pass only while the fix is uncommitted; after the commit HEAD IS the fix and the "old script fails" cases go red. Pin the pre-fix blob by commit SHA (or `HEAD~1`, or a fixture copy). Also check whether `scripts/*.test.mjs` is wired into any workflow — a red test no job runs is a gate that lies ([[patterns-neo164-test-completeness-gate]]).

**PATH-prepended gcloud stubs** are safe when the test (a) never passes `--apply` and (b) uses a fake project; residual shadowing holes are exported bash functions (`BASH_FUNC_gcloud%%`) and `BASH_ENV` inherited via `...process.env`. Mention as a note, not a finding.
