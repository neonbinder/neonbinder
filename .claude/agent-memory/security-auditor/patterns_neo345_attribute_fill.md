---
name: patterns-neo345-attribute-fill
description: NEO-345 BSC attribute fill + leaf autograph format — node-only feature keys need every copy-down door, a Proxy-recorded ctx makes dry and armed one planner, and an internal re-ask mode added to an unarmed enqueuer defaults live
metadata:
  type: project
---

What held, and is worth re-checking when this area changes:

- A node-only feature key (`autographFormat`) is safe only while EVERY
  copy-down spreads `inheritableFeatures(...)` instead of the parent's raw
  map, the generic doors (`setSelectorOptionFeature`, `setCardFeature`,
  `materializeSelectorOptionFeature`) refuse the key, and the card merge
  (`mergeCardFeatures`) strips it. Grep `...(<x>.features ?? {})` on any new
  selectorOptions/cardChecklist insert path; `sourceDataOf` (set shape move)
  carries it deliberately with the moving row.
- Dedicated public door shape that passed: `requireAdmin` first, literal-union
  arg (closed vocabulary in the validator), level allowlist, schedule an
  internal action that walks one bounded mutation per page and re-reads the
  leaf each page to abandon a superseded walk.
- Dry/armed parity via a `Proxy` over `ctx.db` that records `patch` and
  throws on insert/replace/delete — the fill itself is the planner. Check
  the proxy still covers every write verb if the fill grows one.
- Untrusted marketplace token lists: bound (count + per-token length, drop
  not truncate) BEFORE normalising, at every parse site AND again inside the
  stored-row fill.

Trap: an existing UNARMED internal enqueuer (`enqueueBscTeamBackfill`) grew a
"reask" mode that clears stamps and spends live marketplace requests, with
`dryRun` defaulting false. New write modes on an old internal should take
the armed shape (dry default + confirm), see [[patterns-neo289-enrichment-fixtures]].

Invariant watch: a fill-empty union of stored ∪ marketplace tokens re-adds a
token the operator removed whenever the marketplace is asked again (re-ask),
and "explicit false counts as empty" flips typed flags back to true.
