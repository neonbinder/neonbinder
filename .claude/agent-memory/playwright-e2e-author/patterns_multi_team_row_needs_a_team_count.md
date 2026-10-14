---
name: multi-team-row-needs-a-team-count
description: A checklist row's team sub-line joins linked teams with ", ", so "A, B" reads the same as ONE team named "A, B"; prove two links with a Team Management count ("1 match" on one half, NEO-330 counter + server word-prefix search), and gate wizard team-step checks on the lookups settling
metadata:
  type: reference
---

**The row cannot tell two links from one combined team.** `CardChecklistItem`
builds the sub-line as `teamRows.map(teamFullName).join(", ")` then
`subParts.join(" · ")`. So `Boston Red Sox, Detroit Tigers` is what
BOTH a correctly split card and a card linked to one combined team print. A
full-match regex on the sub-line, `(A, B|B, A)( · .*)?`, does rule out a
one-sided link and an `X (unconfirmed)` tail, but not the combined team.

**Close it with Team Management's counter.** Since NEO-330 the screen asks
`teams.searchForManagement` from two typed characters and keeps a row when
EVERY typed word starts a word of its full name or an alias
(`teamMatchesFilter`). The counter is `N teams` browsing (page gate
`[0-9,]+ teams?( . [0-9,]+ need attention)?`) and `N match(es)` filtering,
never "N of M". Filter one half (`Boston Red Sox`) and wait for
`1 match( . [0-9,]+ need attention)?`: a combined team carries the same
words whichever order it was joined in, so "1 match" is the positive and the
negative in one read. The browser-side interim count runs over a capped
window first, so anchor a row assert under the counter to rule out an
interim "1 match" on the wrong row. Scope
it to a name, never a bare `,`: real teams and staged Wikidata career teams
can carry commas, and other flows' rows are on the same preview. The master
row's first line is the SHORT name, which is `Red Sox` or, when the New
Team step left Location blank, the whole name, so match
`(Boston )?Red Sox` below the counter.

**Checking every wizard team step needs the lookups settled first.** Team
rows go through the Wikidata pool like players (`startBatch` inserts them
`pending`) and are presented only once settled, teams before players. A
"Skip remaining names" pressed before that decides a pending team unseen.
Wait `notVisible: ".*still looking up.*"` (180000, the walk util's external
exception). It is safe straight after `Confirm New Players & Teams`, because
the wizard returns null until its rows load, so the title implies the status
line is live. Check each step on the pinned footer control, whose accessible
name carries the row name: `Skip [^,]+ — (not a team|this team has no
league)`, with a `|Skip .* — not a person` branch for the guard/tap TOCTOU.

Worked example: `playwright/tests/set-selector/checklist-dual-team-card-links-both-teams.spec.ts`
(NEO-333). Related: [[draft-echo-is-not-a-read-back]],
[[neo236-wizard-teams-first-walk]], [[guard-then-tap-toctou]].
