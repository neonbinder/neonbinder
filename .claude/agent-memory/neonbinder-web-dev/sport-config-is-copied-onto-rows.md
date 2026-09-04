---
name: sport-config-is-copied-onto-rows
description: sportConfig defaults are COPIED onto a selectorOptions sport row at creation; editing the defaults never reaches an existing deployment's rows
metadata:
  type: project
---

`convex/sportConfig.ts`'s `SPORT_CONFIG_DEFAULTS` are bootstrap values only.
`storeSelectorOptions` copies them onto a sport-level `selectorOptions` row when
the row is created, and its backfill fires only when the row has NO
`sportConfig` at all. Enrichment then reads the ROW
(`getSportEnrichmentContext`), never the constants.

**Why:** NEO-96 deliberately moved these off name-keyed runtime maps so renaming
a sport could not break SKUs or enrichment. The row owning its config is the
point of that design, and the "only ever ADDS, never overwrites" backfill exists
so an operator edit survives every subsequent sync.

**How to apply:** Correcting a value in `sportConfig.ts` fixes only NEW
deployments and NEW sport rows. Any change to these constants that is meant to
fix production needs a companion repair — there is no admin UI for
`sportConfig`, so it has to be code (a targeted repair at the backfill site, or
a one-shot internal mutation in the style of `convex/backfillCardFeatures.ts`).
Say so explicitly when proposing such a change, or the fix ships inert.

Related: [[external-ids-must-be-verified-live]].
