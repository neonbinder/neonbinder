---
name: capped-master-list-needs-search-and-by-id
description: A `.take(CAP)` master list filtered client-side silently hides every row past the cap (and default insertion order keeps the OLDEST); fix = newest-first window + server search from 2 chars + by-id read for ?param and the open panel; an OR search index needs an every-word pass to keep "N of M" counts honest
metadata:
  type: reference
---

Found in NEO-330 on Team Management (`teams.listForManagement`, cap 2000): the
screen filtered the capped window in the browser and looked `?team=<id>` up in
it, so with a catalogue-sized table no team created after the first 2000 could
ever be found or opened. Nothing errors; the list just reads "No teams match".

**Check for the shape** whenever a list query does `.take(CAP)` and its screen
filters, selects or follows a link by searching the returned array.

**The fix that shipped (mirror of Player Management):**
- Window `.order("desc")` (also on `by_sport_id` — index order is
  `_creationTime` within the key), still name-sorted for display. Same reason
  as `franchises.list` (NEO-254).
- From 2 typed chars (debounced 200ms) a server query over the search index.
  Use its answer only while `debouncedTerm === filter.trim()`; until then keep
  filtering the window so the list never blanks mid-word.
- The open panel and `?param` read by id through a `v.string()` +
  `normalizeId` query (`teams.getByIdParam`, `players.getByIdParam`), with the
  on-screen row standing in until it answers.
- Apply secondary filters (league) server-side BEFORE the limit.

**OR search breaks "1 of N" counts.** Convex search is OR over words (see
[[search-index-is-or-so-longest-token-fallback-is-dead]]): "pittsburgh
crawfords" returns every Pittsburgh team. Many E2E flows assert
`"1 of .* teams.*"` after typing a full name, so a management filter needs an
in-memory every-word pass over a bounded scan (`lib/teams/team-filter.ts`,
shared by server and client so the two phases agree). Typeahead pickers that
just rank (`teams.search`) do not need it.

Keep the counter's shape (`N of M <noun>`) in both modes — a dozen flows anchor
row taps `below:` that regex.
