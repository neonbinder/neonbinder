---
name: neo248-wizard-fixture-via-attached-sl-set
description: DISPROVEN 2026-09-05 — a SportLots-only fetch never reaches the entity-review wizard (the SL adapter emits no players/teams); the working fixture is the REAL set Baseball/2024/Topps/Topps Big League/Base, 88 unknown names, all readers Cancel-Discard.
metadata:
  type: project
---

# NEO-248 — the SL-only wizard fixture DOES NOT WORK (disproven live)

> **⚠️ READ THIS FIRST. The design below was tested end to end against two PR
> previews on 2026-09-05 and it CANNOT reach the entity-review wizard.**
>
> `fetchSportLotsChecklist` (`convex/adapters/sportlots.ts`) **declares**
> `team` / `teams` / `players` in its return validator but its handler never
> sets them — the card it pushes carries only `cardNumber`, `cardName`,
> `attributes`, `printRun`, `autographType`, `isVariation`, `cardVariation`,
> `platformRef`, `sportlotsRef`. The doc comment on `tokenizeSlDescription`
> says so deliberately: *"Team extraction is intentionally NOT attempted here
> … BSC supplies the canonical team in the merged record anyway."*
>
> So **a SportLots-only fetch yields zero unknown player/team names for ANY
> set** — the wizard never opens and every card commits as "needs attention".
> Measured: `Big League Gameday Drip` → "Saved 10 cards. 10 need attention",
> no wizard, `players` unchanged at 494. Run 1 on the mascot set: 26 of 26 the
> same. This is structural, not a bad choice of source set — no candidate list
> fixes it.
>
> **Unknown names reach the wizard only from BSC** (`parsePlayersField` in
> `convex/adapters/buysportscards.ts` emits `players`/`teams`) or from the
> retired hand-added `pendingPlayerNames` path.
>
> A per-worker set cannot become BSC-resolvable either: `BSC_REQUIRED_LEVELS`
> checks the row **at level `setName`**, and the attach dialog writes ids to the
> **variant** row — so a hand-typed set stays unresolvable even though
> `resolveBscFacetFilters` buckets ids by FACET and could have built a valid
> query from a `setName`-tagged slot on the variant. Worth raising as a product
> inconsistency: resolvability is judged per-LEVEL, the query is built per-FACET.
>
> **THE WORKING ANSWER (measured on PR #235's preview, 2026-09-05):** the real,
> BSC-listed set `Baseball → 2024 → Topps → Topps Big League → Base`. It syncs
> through the real hierarchy (Base/Insert/Parallel, no reconcile), pairs 310
> cards, and opens the wizard on **88 unknown names — 87 players + 1 team**,
> first row a player with the career-team form and "Back to matching" present.
> `setup.yaml` provisions its structure and Base mapping and must NEVER fetch
> its checklist — committing would make those 87 players known and destroy the
> fixture.
>
> **All readers must Cancel → Discard.** CI has NO serialization: `run-e2e-queue.sh`
> filters only `util`/`wip`/`setup`; `isolated`, `serial-marketplace` and the
> dep-graph lanes exist ONLY in the local `run-e2e-smoke.sh`. "Sole writer"
> (1996 Score) is a review convention, not a runtime mechanism. Concurrent
> READS are safe — candidates are scoped to the fetching operator and batches
> are keyed by selectorOption + user.
>
> Also rejected on PRODUCT grounds (Jason, 2026-09-05): hand-creating a set with
> `+ Custom` and then attaching marketplace data to it. Hand-creating exists to
> AVOID syncing; if a test syncs, it must sync through the real hierarchy. And
> an insert set never has a "Base" variant.
>
> The rest of this note describes the attach-dialog mechanics accurately and is
> kept for those details, which were confirmed live.

## The original (disproven) idea

**The problem.** Quick-add's Players field is a PlayerPicker, so a hand-added
card is born LINKED and never carries a `pendingPlayerName`. A marketplace-free
subtree therefore cannot produce an unknown name, and the six flows that reached
the wizard that way were retired (NEO-220/221).

**The mechanism that gives it back.** NEO-239 made resolvability PER SIDE, and
the two sides need different ancestors:

| side | needs |
|---|---|
| BSC | ids at `sport`, `year`, `setName` + a `variant`-TAGGED slot on `variantType` |
| SportLots (checklist fetch) | ids at `sport`, `year` only — the set id comes off the deepest variant row's slot |

So a **hand-typed set under the REAL Baseball / 2024 / Topps ancestors** is
BSC-unresolvable for good (its `setName` row has no BSC id and never will), and
becomes SportLots-resolvable the moment ONE SportLots set id is attached to the
variant row. The result is a private, per-worker, per-attempt set that fetches a
real one-sided checklist: real unknown names, no shared row written, no BSC cost.

Path: `MultiSourcePanel` ("Attach more source sets") → `AttachSetsDialog`
(`fetchSlAttachSets` fills the SL pane; `SL_ATTACH_REQUIRED_LEVELS` = sport,
year, manufacturer, all real here) → `attachPlatformIds` → Sync card checklist →
`CardPairingModal` with everything in the **SportLots only** bucket → Keep all →
Confirm card matches → `EntityReviewWizard`.

Two gates that surprised me while reading the code:

* `resolveAttachContext` **throws** unless the row's level is
  `variantType | insert | parallel`. Drill to an Insert → Base variant.
* `MultiSourcePanel` no longer hides on rows with no ids (NEO-239) — attaching
  the FIRST id is exactly what it is for.

## The constraint that shapes every flow on it: NEVER create a player

`players` is GLOBAL and empty at the head of every run. A name one worker "adds
as new" stops being unknown for every worker that fetches the SAME SportLots set
afterwards — which quietly drains the fixture until a later flow's wizard never
opens. So flows on this fixture end in **Discard** or decide every row as
**skip / link**. Skips are per-set, so they do not leak. This is a fixture
constraint, not tidiness.

## What the source set has to be (all five, probe before approving)

Under Baseball / 2024 / Topps; small; **its players not already in `players`**
(setup commits every Topps Chrome Base / Future Stars / Gold Wave player) but at
least TWO unknown names; **its teams already known** (the wizard shows one row at
a time and which settles first is a Wikidata race, so unknown TEAMS make "the
current row is a player" a coin flip); and no other SL set in the pane may
contain its name as a substring, because `id:` is a regex find.

Name it as the attach pane DISPLAYS it — `fetchSlAttachSets` passes
`labelContext: { manufacturer }`, which strips the brand prefix.

Related: [[neo239-retire-custom-flow-impact]], [[per-worker-data-isolation]].
