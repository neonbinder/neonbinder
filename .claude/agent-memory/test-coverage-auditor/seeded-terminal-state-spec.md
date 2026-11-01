---
name: Seeded terminal-state spec
description: When a spec seeds an end state (a failed row) and then drives a real path from it, trace that path to its terminal and check the cap/closed variants are proven, not just the first hop
type: pattern
---

A spec that cannot produce a failure on cue seeds the failed row directly and
then drives the product's real retry path from it. Audit it in three steps:

1. **Trace the follow-on path to an end.** A retried row with no stored object
   must hit a TERMINAL classification in the adapter (a 4xx in the adapter's
   terminal set raised as the pool's non-retryable error), or the pool's
   backoff ladder runs and the spec's long wait becomes the real ceiling.
   Name the status code and the class it maps to in the report.
2. **Trace what "close" does to a row set that is all failed.** Closing can
   finalize the job inline to `failed`; check the screen's run query does not
   key on job status, so the pile still renders after the close.
3. **Check every variant the UI derives from a new field.** A counter added
   to a list query (e.g. retries) to hide a button at a cap is a wiring path
   a pure-helper unit test does not prove; ask the spec to press to the cap
   when each press is seconds, rather than accept "closed" as the only proof
   the button can go.

Also check the sign-in gate: the first assertion after `signIn` is
`LAUNCH_GATE`, not a hand-picked 30 s / 15 s pair. A seed hop (reset + seed
+ lazy route) makes the launch longer, not shorter.
