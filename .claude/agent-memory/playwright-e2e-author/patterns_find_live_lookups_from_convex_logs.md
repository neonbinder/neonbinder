---
name: find-live-lookups-from-convex-logs
description: How to list every entity lookup a CI run sent to live Wikidata (and which were genuine no-matches) from the per-shard convex-logs artifacts, and how a spec avoids the lookup
metadata:
  type: reference
---

**Every lookup logs its fixture outcome.** In the `convex-logs-<project>-<n>`
artifacts (gzipped JSONL, one Convex function execution per line; each shard's
file holds the whole deployment's window, so dedupe by `executionId`), the
`logLines[].messages` carry `{"msg":"enrichment_fixture","outcome":"hit"|"miss","kind","name"}`.
`identifier` says who asked: `adapters/wikidata:runEntityReviewLookup` (a
wizard row), `enrichPlayer` (a player the product just created), `enrichLeague`.
A `miss` went live. The artifacts download through the public GitHub API
(`/actions/artifacts/<id>/zip`) even where job logs are blocked.

**Genuine no-matches are logged too.** `wikidata_player_no_match` /
`wikidata_team_no_match` (with the sport label) and `wikidata_league_no_match`
are written only after a completed search found nothing (a transport failure
returns before the log; a team with an ESPN answer returns that instead). Such
a line is a captured `null` answer, usable as a recording entry (an entry for a sport
other than the file's default carries its own `sportQid`). Names with real
answers can be captured without local Wikidata access by calling the
deployment's `adapters/wikidata:runCaptureLookups` with explicit items (it
writes nothing); see the fixture runbook §4b.

**What never costs a lookup:** a team created anywhere (NEO-254), anything in
a sport without `sportConfig.wikidata` (custom sports, Soccer, Golf...), a
checklist name the catalogue resolves to exactly one player, and a name two
players share (inserted ready, NEO-332). A player or league the product
CREATES is always looked up once, so a minted scaffolding name is a live miss.
Use `support/recorded-names.ts` (recorded Baseball no-matches, one per worker
per spec) for a scaffolding Baseball player; such a spec becomes fresh-only.

**Picking names offline:** a recorded-null name that the catalogue-loaded CI
preview staged WITH a lookup in both passes is proven absent from the
catalogue (a resolved name is not staged; a shared name is staged without a
lookup). A two-token real name breaks any spec that asserts an exact players
search COUNT (search is word-wise), so keep minted single tokens there.
