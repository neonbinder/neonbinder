---
name: neo335-team-answer-commit-tests
description: NEO-335 commit team-answer tests — cancelled queue rows persist across re-sync, paging validation needs 501 distinct ids, leaf default vs teamNone, key rows by bsc ref
metadata:
  type: reference
---

Patterns from the NEO-335 adversarial pass (`commitCardChecklist.teamAnswers.test.ts`,
`teams-on-cards.test.tsx`, `CardChecklist.test.tsx` teams-only block).

- **Re-sync queue assertions count a DELTA.** `drainScheduled` + `cancelScheduled`
  after the first sync leave the `processBscTeamEnrichmentQueue` row in
  `_scheduled_functions` (status cancelled), so "not queued on re-sync" must be
  `entriesFor(rowId) after === before`, never `!ids.has(rowId)`.
- **Paged validation (`validateOperatorTeamIds`, 500 ids/page)** is only exercised
  with 501 DISTINCT team ids spread over cards of `MAX_CARD_TEAMS` each; convex-test
  seeds 501 teams in one `t.run` in well under a second. Pin both directions: a
  foreign id on page 2 refuses, a valid page-2 id reaches the title (name map).
- **Set-level team vs "No team"**: patch the leaf's `teamIds`; only the insert branch
  applies the default, so the teams-win check must read the post-default ids.
  Before this pass no test caught `hasTeam` reading `card.teamOnCardIds`.
- **Card numbers are not keys**: key fixture rows by `platformData.bsc.ref`; the
  commit inserts three cards sharing one number happily.
- **Second sync in CardChecklist tests**: stream `undefined` candidates before the
  second `syncTeamless`, or the unchanged stream never triggers `resolveEntities`.

Related: [[reference_neo247_bsc_multicard_reschedule_needs_cancel]], [[a-green-suite-can-mean-the-test-stopped-testing]].
