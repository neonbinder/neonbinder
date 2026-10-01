---
name: checklist-sync-is-one-time-never-store-dialog-answers
description: Jason's ruling (2026-09-28, NEO-312): set/checklist sync is a one-time build event; never persist wizard or dialog answers (pairs, ignores, skips); parallels of an insert are a build-time copy of the insert's NB cards linked to their own marketplace cards; E2E reaches two-sided pairing on the live path (SportLots unpaused 2026-09-21)
metadata:
  type: feedback
---

Plan checklist features as ONE-TIME BUILD steps, never as sync/re-sync
bookkeeping. Jason, 2026-09-28, verbatim: "There is no syncing and resyncing
worry. We do not need to keep track of what was accepted/rejected for any
long term solutioning… once we complete the building of the set/checklist
any data that isn't simply the set/checklist and then each set/card's
mapping to the marketplaces is extraneous data we do not want to be
storing." Related rulings the same day: sync is a one-time event; if a
re-sync must rebuild, that is fine; never store wizard or dialog answers.

**Why:** a first NEO-312 plan proposed a `checklistDeclines` table, an
`inherited` candidate field and precedence tiers so pair/ignore decisions
would survive re-syncs. Rejected on premise: NB owns the cards; the only
marketplace data worth keeping is each card's ref per side.

**How to apply:** "carry decisions through" means copy the committed NB rows
(the truth) and re-link each copy to its own marketplace card with an
exactly-one guard; an ignored card was never committed, so nothing has to
remember it. Do not add tables or fields whose only reader is a later
re-sync. Also (fact, not ruling): the pairing modal emits only refs on
cards; ignore = absence, unlink does not stick. CORRECTION (2026-09-29):
this note used to say SportLots was paused on the E2E path so Match Cards
never opens. It is NOT — the pause was lifted 2026-09-21 and CI passes
`PAUSED_PLATFORMS` empty, so real fixtures are two-sided and Match Cards does
open; plan the live E2E proof. The paused branches still exist in the flows;
check a run with `gh run view <id> --log | grep -m1 "PAUSED_PLATFORMS: "`
(empty = live) before planning around either mode.
