---
name: patterns_failure_screenshot_shows_the_finally_end_state
description: On a spec with a self-cleaning finally, the failure PNG is taken after cleanup; read the blob's error-context ARIA snapshot for the moment it failed
metadata:
  type: feedback
---

Playwright's `only-on-failure` screenshot is taken after the test body AND its
`finally` have run. In a spec that cleans up after itself (reopen, Done, remove
the copy), the PNG shows the cleanup's end state, not the failing moment. NEO-481:
a recrop spec's PNG showed a checklist and an empty card drawer, which read like
a wrong `goto`; the real failure was a view-only viewer opened by a load race.

**How to apply:** for any red in a spec with a cleanup `finally`, open the
blob report (`report/blob`) and read the error-context ARIA snapshot under
`resources/` before trusting the PNG. Related: [[patterns_finally_cleanup_without_an_isvisible_branch]].
