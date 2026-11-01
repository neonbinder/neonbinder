---
name: scheduled-deadline-keyed-on-row-id
description: A deadline scheduled with only a row id, plus a retry/restart that resets the row, lets the old deadline fire on the new attempt; per-feature tests stay green
metadata:
  type: project
---

When a PR adds a `ctx.scheduler.runAfter(DEADLINE, expireX, { id })` whose
handler only checks the row's status, and the same or a later PR adds a
retry/restart that puts the row back into that status, a deadline from the old
attempt can expire the new one early. The deadline is never cancelled when the
attempt settles early. Deadline tests and retry tests each pass on their own.

**How to apply:** for every scheduled deadline, ask what makes the row
"processing" again (Try again, job restart, upsert over rows) and require a
unit test that runs the OLD scheduled function after the reset and asserts it
does nothing. The fix is a stamp or generation in the scheduled args that the
handler compares with the row.
