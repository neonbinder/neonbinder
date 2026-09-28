---
name: review-row-sport-can-differ-from-the-set
description: Since NEO-313 an entityReviewQueue row's sportId is the sport the operator ANSWERED in (switchRowSport), not always the set's — prelude helpers take the row's sport and staged maps key on sport+name
metadata:
  type: reference
---

`entityReviewQueue.sportId` used to equal the commit's `args.sportId` by
construction. After NEO-313 the operator can re-point one row at another sport
(`switchRowSport`), and its staged career-team / league children follow it.

In `commitCardChecklistPrelude` that means:
- `createTeamFromOperatorInput` (opts.sportId), `reviewedTeamFields`,
  `leagueAnswered`, `resolveTeamIdByName` all take a sport param defaulting to
  `args.sportId`; callers pass the REVIEW ROW's `sportId`.
- `stagedTeamIdByLabel` / `stagedLeagueIdByName` are keyed `sport|name`
  (`stagedTeamKey` / `stagedLeagueKey`) — a switched player's football career
  label must not answer a baseball player's stint.
- The automated fast paths (`sameNamePlayers(args.sportId)`,
  `resolveTeamForSetYear(args.sportId)`) stay on the SET's sport. Only the
  operator's decision carries another sport. Never add a cross-sport read there.

**How to apply:** any new prelude code that reads `args.sportId` for a
create/link/staged row should ask "is this the set's sport or the row's?" —
decisions use the row's; unreviewed resolution uses the set's.

Related: [[review-batch-rows-the-batch-stages-itself]].
