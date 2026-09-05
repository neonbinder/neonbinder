---
name: neo248-wizard-fixture-via-attached-sl-set
description: How the entity-review wizard is reachable from a PER-WORKER set again after NEO-239 — attach one SportLots set id to a hand-typed set under real Baseball/2024/Topps; what the source set must satisfy, and why no flow on it may create a player
metadata:
  type: project
---

# NEO-248 — the wizard on a per-worker set, via one attached SportLots id

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
