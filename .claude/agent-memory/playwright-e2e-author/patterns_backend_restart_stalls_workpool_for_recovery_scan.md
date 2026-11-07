---
name: patterns-backend-restart-stalls-workpool-for-recovery-scan
description: A backend restart can stop a workpool for its full 5-minute recovery scan, so a 180 s lookup ceiling goes red; the signature is a zero-lookup gap of exactly 5:00 after a transient action error
metadata:
  type: project
---

A backend restart can stop a workpool until its recovery scan runs, 5 minutes
later. A spec waiting on the 180 s lookup ceiling goes red on "still looking
up" even though nothing in the spec or the flow is wrong.

**Signature:** in the Convex logs, `Transient error while executing action`,
then no lookups at all for exactly 5:00, then lookups resume.

**Why:** the gap is the pool's own recovery interval, so a longer ceiling is
not the answer, and the 180 s budget stays as it is.

**How to apply:** read the logs for the gap before forming a theory. If the
signature is there, it is not a spec bug: rerun the whole workflow, never only
the failed jobs. If it is not there, the mechanism is something else, so keep
looking. See [[reference-flake-runtime-forensics]].
