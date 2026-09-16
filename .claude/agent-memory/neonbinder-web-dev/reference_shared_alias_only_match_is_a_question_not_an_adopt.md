---
name: shared-alias-only-match-is-a-question-not-an-adopt
description: In an entity loader, two rows that touch ONLY through a shared "also known as" string are not the same entity — adopt on a primary-name leg, park a shared-alias-only hit as ambiguous; and in nearMatches never let the search-index loop overwrite an exact-leg candidate (it drops matchedAlias)
metadata:
  type: reference
---

Two lessons from building the NEO-284 team preload (`convex/bulkLoad.ts`), both found by a scratch convex-test before handback.

1. **Alias = alias is not identity evidence.** A loader that matches "rows sharing an alias with the incoming row" adopts the wrong entity the moment prod holds an operator-typed alias the dataset attaches elsewhere (prod "Miami / RedHawks" alias "Miami"; incoming "Miami / Hurricanes" alias "Miami" → adopted the RedHawks, wrote the Hurricanes' years, Q-id and aliases onto it, nothing anywhere said so). One side's PRIMARY name being the other's alias IS evidence (a raw Wikidata-label row vs the dataset's canonical split). So: adopt when a primary name vouches; a hit reached only through a shared alias is `ambiguous` with `matchedOn`, and the operator answers.

2. **`nearMatches` candidate map: `if (candidates.has(id)) continue` in the search loop.** "LSU" prefix-matches "lsu tigers" in the search index too, so the search leg re-`set()` the same row WITHOUT `matchedAlias`, the ranker scored it `close` on its own name, and the wizard lost its primary "Link to …". Fixed in both `teams.nearMatches` and `players.nearMatches` in NEO-284 (`if (candidates.has(hit._id)) continue`).

**How to apply:** any loader or resolver that unions a primary-name leg with an alias leg: track which leg vouched per candidate, and treat merge-by-id as first-writer-wins so annotations from the exact leg survive.
