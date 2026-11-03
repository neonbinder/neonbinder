---
name: patterns-ci-cross-run-queue
description: Auditing a CI mutex/queue built by polling other runs' jobs via gh api (NEO-415 seller queue) — fork runs forge holders, partial reads fail open, GITHUB_TOKEN per-repo rate budget
metadata:
  type: reference
---

When a job serialises a shared resource by listing in-progress runs and their
jobs (`gh api .../actions/runs?status=in_progress` then `.../runs/<id>/jobs`)
and deciding by job name / step state / start time:

- **Fork runs are in that list and run their own edited workflow.** A fork can
  add any job whose name matches the queue regex, with a step named like the
  wait step that "succeeds", and sleep up to 6 h: every waiter sees a holder.
  Filter the runs listing with
  `select(.head_repository.full_name == env.GITHUB_REPOSITORY)` (the house
  shape already used by e2e.yml's `timings` job, see [[cross-run-artifacts]]).
  Honest fork PRs get no secrets, so they can never reach the guarded step;
  excluding them costs nothing.
- **Partial reads fail OPEN.** A `for rid in ...; do gh api ... 2>/dev/null; done | jq -s`
  loop drops a run whose jobs call failed (rate limit, 5xx) and still
  produces valid JSON, so the holder vanishes and the waiter goes. Any failed
  call in a poll must make that poll "unreadable" (wait), never a smaller list.
  Also require the runs listing's `total_count` <= per_page.
- **GITHUB_TOKEN is ~1,000 REST requests/hour per repository**, shared by every
  job (paths-filter, sticky comments, timings). Waiters x (1 + in-progress runs)
  x polls/hour exhausts it exactly when a queue forms; the 403s then hit
  unrelated jobs. Budget the arithmetic, poll slower, list per-workflow, log
  `X-RateLimit-Remaining`, and do not swallow stderr.
- Names from other runs echoed to stdout are a workflow-command channel
  (`::error::`, `::add-mask::`) if they can carry a newline; print run ids only.
- A queue only covers the job window. Background writers (crons on a preview
  still connected to the shared account after a cancelled run skipped its
  afterEach) are outside it.
- Two verbatim copies of the poll script drift; one script file, two callers.

**Shape that held (NEO-415 re-review):** one script in `.github/scripts/`,
own place read once from this run's jobs (matched by `RUNNER_NAME`), per-workflow
`runs?status=in_progress` listings filtered on `head_repository`, own run
excluded, every `gh api` failure or `total_count > per_page` returns
"unreadable", job regex anchored both ends with the caller prefix optional,
only numeric run ids echoed, stderr passed through a `::`-neutraliser, rate
read from the free `rate_limit` endpoint. Re-check on change: the script stays
committed as 100755, the regex still matches the caller job's `name:`, and a
fake-`GH` test proves the fail-closed branches (claims in comments are not proof).
