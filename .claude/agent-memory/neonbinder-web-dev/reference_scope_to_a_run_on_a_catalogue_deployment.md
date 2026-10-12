---
name: scope-to-a-run-on-a-catalogue-deployment
description: On a reference-catalogue preview, "rows this run made" = an index range from a _creationTime boundary (catalogue keeps source _creationTime); `convex run` prints PRETTY JSON off a TTY, so `tail -n 1 | json.load` never parses
metadata:
  type: reference
---

Since NEO-330 every CI preview is loaded with the reference catalogue before
the seed (six-figure players, five-figure teams). Any "list every row of the
sport" tool turns into noise or a read-limit failure there.

**The discriminator is `_creationTime`, not a field.** The reference-seed
bundle keeps each row's SOURCE `_id` and `_creationTime`, so every catalogue
row is older than anything the run creates. Every Convex index ends in
`_creationTime`, so `withIndex("by_sport_id", q => q.eq("sportId", s).gte("_creationTime", t))`
reads only the run's rows, and tables with no useful index range over the
built-in `withIndex("by_creation_time", q => q.gte("_creationTime", t))`
(convex-test supports both). A default `t` with no caller input: the oldest
`year` row (`by_level` + `.first()`); the CI load leaves `selectorOptions`
holding sport rows only, and a name reaches the review wizard only through a
set. Used by `enrichmentFixtures.listLookedUpNames` (NEO-330 W7). Prove the
range with `transactionLimits: { documentsRead: 100 }` over 5k+ older rows;
the wide read throws.

`players.createdByUserId` is stripped from the bundle, but teams/leagues have
no such field and nothing indexes it, so it cannot discriminate.

**`npx convex run` output off a TTY is `JSON.stringify(result, null, 2)`**
(`formatValue` in `convex/dist/esm/cli/lib/run.js`): multi-line. A workflow
step that parses `tail -n 1` gets `}` and its `except` branch fires every
time. Parse the whole stdout instead (keep stderr out of it).
