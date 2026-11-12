---
name: picker-context-league-is-the-rows-own-feature
description: teams.pickerCandidates reads L only from the context row's OWN features.league (the year walks up, the league does not); real rows carry it by creation copy-down, so prove tiers on a tree built with addCustomSelectorOption
metadata:
  type: reference
---

`pickerContext` in `convex/teams.ts` walks UP from `contextOptionId` for the
year, but reads the league from the context row's own `features.league` only.
Real rows are fine: the sport row is born with `league` (`deriveOwnLevelFeatures`,
`SPORT_TO_LEAGUE`) and every node-creation site copies `inheritableFeatures` of
its parent down at insert, so a setName, variantType or insert row carries
"MLB". A hand-seeded fixture that puts `features` on the setName only makes a
variant-level context resolve no league (every row tier 4 or 2), which reads
like a product bug but is a fixture artefact.

**How to apply:** to prove a picker that passes the wizard's
`selectorOptionId` ranks by the set, build the tree through
`api.selectorOptions.addCustomSelectorOption` as an admin (sport → year →
manufacturer → setName → variantType), as `cardFeatureDerivation.test.ts` does
(NEO-518 test in `teams.pickerCandidates.test.ts`). The context is honoured for
admins only; a non-admin always gets tier 4. If a real deployment shows every
row at tier 4, suspect rows created before the copy-down existed, or a league
row whose name, alias and abbreviation all miss "MLB". Related:
[[search-mock-must-honour-query-args]].
