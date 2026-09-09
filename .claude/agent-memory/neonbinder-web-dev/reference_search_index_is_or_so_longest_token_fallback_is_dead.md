---
name: search-index-is-or-so-longest-token-fallback-is-dead
description: Both Convex and convex-test full-text search are OR over query terms, so the `if (hits.length === 0) retry with longestToken(name)` fallback in teams.nearMatches and players.nearMatches can never fire — the fallback term is always one of the terms that already missed
metadata:
  type: reference
---

`convex-test`'s `evaluateSearchFilter` (node_modules/convex-test/dist/index.js,
~line 719) is:

```js
queryTerms.some((queryTerm) => documentWords.some((word) => word.startsWith(queryTerm)))
```

**OR, not AND** — a document matching ANY query term is a hit. The real Convex
backend is OR-ish too (BM25 ranking over matched terms); the difference is that
convex-test prefix-matches EVERY term where Convex prefix-matches only the
FINAL one, applies no ranking, and splits document text on whitespace only
(keeping punctuation, which the real `SimpleTokenizer` strips).

**The consequence, and it is not obvious from reading the code.** Both
`teams.nearMatches` and `players.nearMatches` do:

```ts
let hits = await search(name);
if (hits.length === 0) {
  const fallbackTerm = longestToken(name);   // players: the LAST token
  if (fallbackTerm) hits = await search(fallbackTerm);
}
```

`longestToken(name)` (and players' last token) is by construction one of the
tokens the whole-name query already contained. Under OR, if the fallback term
would match, the whole-name query already matched — so `hits.length === 0` is
unreachable whenever the fallback could help. **The branch is dead.** Its
stated purpose (rescuing a row that BM25 crowded out of the top ten) needs a
different trigger than "no hits at all" — e.g. always run it and merge, or
trigger on "the exact row is absent from the hits".

It *appeared* live in `convex/teams.search.test.ts` before NEO-236 purely as a
convex-test artefact: the index covered the raw `name` (punctuation kept
locally), so "N.Y. Yankees." prefix-matched nothing and the first search
returned []. NEO-236 moved the team index to `nameNormalized` and normalised
the query with `nameTokens(...).join(" ")`, which closed that gap and made the
deadness visible. Confirmed empirically by instrumenting the branch: 0 hits
across the whole `teams.search.test.ts` file.

**How to apply:** do not add another `hits.length === 0` fallback in this shape,
and do not "fix" a near-match miss by reaching for one. If a ticket asks to make
the fallback earn its place, change the trigger, not the term. See also
[[convex-components-unregistered-in-convex-test]] for the other class of
convex-test approximation that changes what a test proves.
