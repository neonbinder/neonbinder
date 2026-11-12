---
name: compare-a-publisher-checklist-with-bsc-facets
description: One unauthenticated shop-search call per variant gives every BSC section name and card count of a set; diff it against a publisher file's sections before designing a "section the marketplace lacks" step
metadata:
  type: reference
---

BSC's storefront search (`search/shop/results`, recipe in the capture tool and
[[capture-checklist-slug-probe]]) with filters `{sport, year, setName, variant}`
and `size: 1` returns `aggregations.variantName` (`label|slug|count`) for the
whole set: every insert, insert parallel and parallel in one ~0.3 s call.

Facts it showed for 2026 releases (NEO-496), likely general:
- BSC files an insert's parallels as more INSERT variant names
  ("Bomb Squad Red Ice" is variant `insert`), so a one-marketplace Insert column
  stores them flat and Group Parallels' prefix rule nests them later.
- BSC names Base parallels bare ("Red", "Optic Gold", 200 cards: Base and the
  prospects subset together); a publisher file names them "Base Red" and
  "Base Rated Prospects Red". Exact-name equality only holds for insert families.
- Count mismatches are often other-sport cards misfiled by BSC (football `FP-xx`,
  `SG-xx` numbers in a baseball insert): a ready-made "card only BSC has" case.

**How to apply:** before a plan says "a section BSC does not list", diff the
file's section list against the aggregation (case-folded); a guess like "the
rare colour is missing" was wrong for 2026 Donruss Bomb Squad (all 14 listed).
Publisher PDFs carry ® and ™ after team names; a fixture or parser that keeps
them will not resolve the team.
