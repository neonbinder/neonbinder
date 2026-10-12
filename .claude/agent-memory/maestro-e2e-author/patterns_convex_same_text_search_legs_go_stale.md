---
name: convex-same-text-search-legs-go-stale
description: A Convex query running two withSearchIndex reads with the SAME text on the SAME index (different filters) is invalidated only by docs matching the narrower filter — the answer goes stale; how to prove it from the browser's websocket frames and the HTTP API
metadata:
  type: reference
---

**The symptom (NEO-331, 2026-10-10).** A picker list was missing a row the
server returned to every fresh probe. Not held rows, not timing: the CLIENT
had a server answer, and that answer was minutes old. Gate never went green
even at 45s.

**The mechanism, measured.** `teams.pickerCandidates` ran leg A
`search_name` filtered by sport AND league, then leg B the same text filtered
by sport only. Inserting a team in ANY other league (or none) did not
invalidate an already-computed answer for those args: re-querying the same
args returned the pre-insert result for 3.5+ min. Without leg A (no context)
the same insert invalidated at once. A team in the filtered league did
invalidate; so did any write to another table the query reads (a new league
row). So the search read set behaves as if only the narrower filter is
tracked. Order-dependence untested. Fix in product, never in the flow: one
search per (index, text) per query, or read the league leg through a plain
index (`by_league_id`) instead.

**Why it bites flows.** Typing `<prefix>W` char by char before creating W
subscribes `<prefix>` too; typing `<prefix>` again later re-uses that exact
args tuple and gets the stale answer. A never-typed prefix is fresh.

**Proving it (recipe).**
- HTTP probe: sign in over raw CDP (`/testing/sign-in?...&worker=0`), take
  `window.Clerk.session.getToken({template:"convex"})`, then POST
  `<convex-url>/api/query` / `/api/mutation` with `{path:"mod:fn", args,
  format:"json"}` and `Authorization: Bearer`. Warm the args, insert ONE row,
  re-query on a loop. Insert only the suspect row: a second, matching insert
  invalidates the cache and hides the bug.
- Client frames: attach a second CDP client to Maestro's own Chrome (port in
  `<chromedriver scoped_dir>/DevToolsActivePort`; pick the page whose URL has
  your Vite port, other agents' Chromes may be running), `Network.enable`,
  log `Network.webSocketFrameSent/Received` — Convex `ModifyQuerySet` Add
  (udfPath + args) and `Transition` QueryUpdated per queryId.
- Run the watcher with `run_in_background`: two Bash calls in one message
  run SEQUENTIALLY, so a foreground watcher never sees the Maestro run.

Related: [[capture-browser-console-with-cdp]], [[probe-a-fixture-without-draining-it]],
[[present-in-failure-dump-means-late-arrival]], [[neo331-team-picker-ranking]].
