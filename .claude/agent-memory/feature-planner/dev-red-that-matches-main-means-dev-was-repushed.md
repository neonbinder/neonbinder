---
name: dev-red-that-matches-main-means-dev-was-repushed
description: A local spec red on dev where the server's answer matches origin/main's code, not the branch's, with no "function not found" error — another session pushed dev mid-run; check the trace's wall-clock against the push before diagnosing a product bug
metadata:
  type: feedback
---

Before diagnosing a dev-run red as a product or spec bug, compare the server's
observable answer (a status message, a count, an undo shape) against
`git show origin/main:<convex file>` as well as the branch. If main's code
predicts the answer exactly and the branch's does not, another session
re-pushed dev with a main-based branch during the run. CLAUDE.md names the
loud symptom ("Could not find public function"); this is the silent one: the
function exists on both sides and simply behaves per main.

**Why:** NEO-431, 2026-11-04: a quick-count spec read "Boxed 2 more" for a
field at 1. Main's `isPlainLine` excluded photo lines, so `before=0`; the
client bundle (the branch, served by local Vite) counted it. The trace's
wall-clock put the + click 9 s after another session's dev push. No bug.

**How to apply:** recover wall-clock from the trace
(`context-options.wallTime + (event.startTime - context-options.monotonicTime)`),
line it up against who pushed dev when, and check that any extra pre-step
(an `expectAccessible` pass is ~15 s) did not merely widen the window. The
re-run is a re-push of the branch to dev plus a worker whose bootstrap
`/testing/reset` wipes the account's copies and photos; nothing is deleted by hand.
