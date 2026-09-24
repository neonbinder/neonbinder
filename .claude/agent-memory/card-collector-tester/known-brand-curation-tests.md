---
name: known-brand-curation-tests
description: The three tests that decide whether a leading set-name word earns a known-brands entry (NEO-294 curation), plus the leading-qualifier artifact family
metadata:
  type: project
---

Curating `apps/web/convex/knownBrands.ts` additions, three tests settle almost every
candidate. Apply them in order; the third is the tie-breaker Jason's MVP rejection implies.

1. **Is it an issuer at all?** Not a team, city, school, league, event, sponsor or a
   magazine. Suffix-only descriptors (Police, Smokey, SGA, Team Issue) need no rejecting —
   a prefix matcher ignores them for free.
2. **Does it mint two rows for one issuer?** Spelling/punctuation/spacing variants are the
   real hazard, because the fold is lowercase+trim only: `Collector's Edge` / `Collectors
   Edge`, `Pro Cards` / `ProCards`, `Coca-Cola` / `Coke`, `Costacos` / `Costaco`. Two such
   entries are *legal* under the no-prefix invariant (a trailing alphanumeric blocks the
   match) but they are still two brand rows for one company — only take both when the
   issuer is major enough that a split row is cheaper than the sets staying Unknown.
3. **Product line of a brand NB already has → does the line outlive its parent?** NB's own
   existing rows already include lines (Ultra→Fleer, Stadium Club and Finest→Topps,
   SP→Upper Deck, Bowman→Topps), so "never a product line" cannot be literal. The working
   test: a line earns its own row when the hobby's catalogue heading is that name ALONE and
   the line crossed owners — Hoops (Hoops Inc./SkyBox→Fleer→Panini) yes; Flair (Fleer only,
   but never spoken with the parent) yes-ish; Collector's Choice and MVP no, they are
   always "Upper Deck ..." and a dealer looks under Upper Deck.

**Leading-qualifier artifacts.** Several families of NB set names carry a leading token
that is not part of the set's name: `Other ...` (a marketplace brand-bucket label; appears
across baseball, football and basketball, often alongside the same set spelled bare),
`Team Issue ...`, and league/nationality qualifiers (`NBA Hoops` vs `Hoops`, `NBA Jam
Session` vs `Jam Session`, `Australian Futera` vs `Futera`). Never put one of these on the
brand list — `Other` in particular would key NB behaviour on a marketplace value. They are
an ingest/strip bug to fix at the adapter boundary; until then those sets stay in Unknown
and their issuer's bare-named siblings file without them.

**Mechanics for a one-line addition:** `knownBrands.test.ts` hard-codes the entry COUNT and
asserts the array is sorted by folded (lowercase) name, and every entry must pass
`checkCustomSelectorValue("manufacturer", ...)` and claim a representative example. An
addition touches the array, the count assertion and the example table.

See [[marketplace-data-is-linkage-only]].
