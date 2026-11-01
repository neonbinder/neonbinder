---
name: Retry chain plus sweep overlap
description: a self-rescheduling retry with a stuck-pending sweep needs a test where both chains run and the stale one finishes last
type: pattern
---
When a Convex action retries itself on a delay ladder AND a cron sweep re-queues
rows "pending longer than X", check whether the ladder's total delay exceeds X.
If it does, the sweep starts a second chain while the first is still retrying,
and a stale chain's terminal write (mark failed) can land after a newer success.
Ask for a unit test that runs two overlapping chains and asserts the final state
is the newer chain's (a generation or token guard on the terminal mutation).

Failure-only UI states (a "failed, Try again" line) cannot be induced from the
browser: prove the markup with a component test that injects the state through
the store hook, and have the existing happy-path spec assert the pending line
clears; do not demand a test-only backdoor just to reach the state in E2E.
