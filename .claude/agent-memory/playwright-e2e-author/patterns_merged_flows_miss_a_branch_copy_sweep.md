---
name: merged-specs-miss-a-branch-copy-sweep
description: After merging main into a branch that swept a copy change across specs, a spec main ADDED still reads the old copy; re-grep the sweep's old patterns after every merge
metadata:
  type: feedback
---

A branch that changes UI copy also sweeps every flow that reads that copy.
When main is merged in later, any flow main ADDED was written against main's
old copy, so it fails on the branch even though both sides were green alone.
The sweep never saw it, and git reports no conflict.

Example: NEO-330 changed the Player Management counter from "N of M players" to
"500 players", "N matches" and "10+ matches", and updated every flow in one
commit. The NEO-332 merge then brought in a pick-step flow whose launch gate
was still a locator for "N of M players". Its first CI run failed at the 45s launch
gate, with "500 players" in the failure screenshot.

**Why:** a gate like this fails on the first read and looks like a slow
sign-in. The screenshot answers it in seconds; a timing theory never would.

**How to apply:** after merging main into a branch that changed copy, grep
the specs for each OLD string or regex the sweep replaced. Fix the specs main
added in the same push. Check the capped and plural forms too: a sweep that
adds "10+ matches" breaks every `[0-9]+ matches` locator whose search can fill
the cap. See [[reference-catalogue-on-ci-previews]].

**Resolving the conflict hunks by script:** split on a LINE that is exactly
`=======`, never on the substring `=======\n`. A banner comment such as
`// ============…` ends in seven `=` and a newline, so a non-greedy
`<<<<<<< HEAD\n(.*?)=======\n` regex cuts the HEAD side at the first banner
inside it and silently keeps half of both sides (NEO-335's merge of NEO-330
did this once). After any scripted resolution, grep for `^=======$` and diff
the file against both parents.
