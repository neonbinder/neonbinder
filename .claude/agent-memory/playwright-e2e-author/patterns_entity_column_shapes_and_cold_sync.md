---
name: entity-column-shapes-and-cold-sync
description: Two EntityColumn facts that break drills — the search input appears only ABOVE 8 entries (until NEO-224 made it unconditional), and an empty column shows its idle Sync button BEFORE the sync starts
metadata:
  type: project
---

# Selector column shapes, and why "Sync <X> is visible" is not "the column has data"

Verified live against dev on 2026-09-03 (NEO-211) with deliberate-failure probes.
Check `EntitySelector.tsx` for the current search-box rule: NEO-224 later made
the box unconditional (see [[search-box-is-not-a-content-signal]]).

## 1. An empty column renders its idle buttons BEFORE the sync starts

`EntityColumn.newPathContent()` shows the `Syncing <X>` panel only while
`selectorSyncStatus.status === "syncing"`. A cold, empty column renders
`Sync <X>` + `+ Custom` **immediately**, and only switches to the panel once
`ensureSelectorOptions` has round-tripped (~300 ms later). So an assertion that
`Sync Sets` is visible passes in the first fraction of a 60 s fetch (a probe
dumped a completely empty Sets column at exactly that moment).

**How to apply:** use the shared cold-column helper (`drillToColdManufacturer`,
and the settle helpers in `support/set-builder.ts`) rather than hand-rolling. The
shape is: `await expect(syncingPanel.or(content)).toBeVisible(...)`, wait for the
panel to go (`toBeHidden`), then assert the content (the row, with the sanctioned
cold-path timeout from GUIDE hard rule 3 only where the fetch is genuinely live).
The VALUE must not match an ancestor's collapsed chip, or the assertion is
satisfied before the column loads. A `toBeHidden` on the panel alone is a
negative: pair it with the positive content assertion ([[negative-asserts-pass-on-a-dead-page]]).

## 2. Enumerating a column's real contents

To find out what a marketplace actually returned, run the spec once with a
deliberately wrong expectation and read `error-context.md` (the ARIA snapshot
lists every option in the column), or `await page.getByRole("listbox", { name:
"Sets" }).getByRole("option").allTextContents()` in a scratch run. Filter the
column first when the list is long. Delete the probe afterwards.

Related: [[project_local_validation_needs_a_pr_preview]].
