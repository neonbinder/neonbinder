# NEO-254 — production data repair (2026-09-10)

Sibling of [`neo214-set-builder-admin-scripts.md`](./neo214-set-builder-admin-scripts.md):
same trust model, same arming pattern, same "do not pass `--identity`" rule.
Read §2.1 and §3 there first if you have not run a scripted admin task before.

## What happened

The NEO-254 Phase B loader put every league, franchise, team and player into
production in one sitting on 2026-09-10. A handful of rows came out wrong, and
no existing write path can correct them from a terminal: the admin mutations
`requireAdmin` (a CLI run carries no identity), nothing moves career stints
between team rows, and `splitTeamLocations` splits only where ESPN agrees.

`apps/web/convex/repairs/neo254ProdData.ts` is the fix: five internal
functions, each armed, each idempotent, each reporting what it changed.
Nothing in that file knows about the Angels — this document is where the
incident's own invocations live.

## The seven functions

All take `confirm: "NEO254_REPAIR"` and refuse unless
`ALLOW_NEO254_REPAIR=true` is set on the target deployment. Every one refuses
on zero matches and on more than one — a team is identified by its composed
name AND the year its era starts, because a name alone may hold several eras.

| Function | What it does | Reports |
|---|---|---|
| `setTeamEra` | re-dates one team row (`yearsActive: null` clears); refuses an era that would overlap a same-name row | `{ teamId, before, after, changed }` |
| `renameFranchise` | renames one franchise, rewriting its dedup key; refuses if `to` already exists | `{ franchiseId, before, after, changed }` |
| `moveStints` | for every player in the sport, re-points stints at `fromTeam` starting in or after `seasonFrom` to `toTeam`, merging into a same-start stint already there; earlier seasons untouched | `{ playersScanned, playersChanged, stintsMoved, isComplete }` |
| `setLeagueAliases` | unions aliases onto one league (never removes); refuses an alias another league in the sport answers to | `{ leagueId, before, after, added, changed }` |
| `resplitSeedTeams` | splits rows still holding a whole name (`"Milwaukee Brewers"`, no `location`) into the Location + Name `SEED_TEAMS` already knows; skips and reports anything ambiguous or colliding | `{ resplit, skipped, nothingToDo, noSport }` |
| `splitTeam` | splits ONE named row into supplied Location + Name — the adopted rows no seed entry names; refuses a key-changing "split", two candidates, or an overlapping sibling | `{ teamId, before, after, changed }` |
| `deleteTeam` | deletes ONE unreachable legacy row, after moving or dropping its stints; ALWAYS refuses if a card or a review still references it | `{ teamId, teamLabel, outcome, playersChanged, stintsMoved, stintsDropped, changed }` |

A second identical run of any of them changes nothing and says so
(`changed: false` / zero counts). `renameFranchise` treats "`from` is gone
and `to` is present" as already done, not as a refusal; `splitTeam` treats
"no unsplit row left, the split row is there" the same way; and `deleteTeam`
reports `outcome: "already_absent"` for a row that is already gone.

### Why `deleteTeam` exists when the app has no delete-team path

It does not open one. What it reaches is narrower: a pre-NEO-236 legacy row
whose name does not compose to the same normalised key as the row that
superseded it. `"Hawks"` keys as `hawks`; the proper row, `"Atlanta" /
"Hawks"`, keys as `atlanta hawks`. Different keys, so the two are invisible to
each other — no lookup finds the legacy row, no rename reaches it (a rename
that changes the key is exactly what `splitTeam` refuses), and
`resplitSeedTeams` cannot touch it. It is an unreachable duplicate, not data.

The refusals are what keep it from becoming a general delete. A team id is
referenced in exactly three places (`grep 'id("teams")' convex/schema.ts`):
`cardChecklist.teamOnCardIds`, `players.teamYears[]`, and
`entityReviewQueue`'s `link` decision. The first and third **always** block —
a card that prints a team, or a review a human is part-way through, must not
lose its referent because a script was armed. Only stints have a policy:

- `{"kind":"refuse"}` (the default) — any stint at all stops the delete and
  names up to ten of the players. You must SAY what happens to them.
- `{"kind":"drop"}` — the entries are removed.
- `{"kind":"move","to":{…}}` — the entries go to another row, **every year of
  them**, through the same merge rule `moveStints` uses. Unlike `moveStints`
  there is no `seasonFrom`: the row is going away, so the whole career moves.

`resplitSeedTeams` and `splitTeam` do the same patch from opposite ends.
`resplitSeedTeams` walks `SEED_TEAMS` and needs no arguments, so it is the
right tool wherever the seed carries the parts — on prod that is 42 unsplit
soccer rows ("Manchester City" → "Manchester" / "City"). `splitTeam` takes the
parts from the operator, and exists for the rows the loader ADOPTED: they
already existed under their whole name, the load hung real stints and an era
on them, and no seed entry names them in that shape.

The module lives in a subfolder, so the function path on the CLI is
`repairs/neo254ProdData:<fn>` (and `internal.repairs.neo254ProdData.<fn>`
in code).

## Running it — this incident

From `apps/web`, logged into Convex as `neonbinder@neonbinder.io`. Take a
**Backup Now** on the prod deployment first
([`neo190-convex-backups.md`](./neo190-convex-backups.md) §3) — these are
patches, not deletes, but the stint move touches every player in the sport.

```bash
cd apps/web

# 0. Arm, and prove which deployment you are pointed at.
npx convex env set ALLOW_NEO254_REPAIR true --prod
npx convex env get ALLOW_NEO254_REPAIR --prod      # expect: true

# 1. Reopen the 1961 Angels row — the wrong 1964 end came from Lahman's
#    "Los Angeles Angels of Anaheim" spelling being read as a separate club.
#    MEASURED on prod 2026-09-10: this row is 1961-1964 and holds 118 stints.
#    Expect before {"from":1961,"to":1964}, after {"from":1961}, changed true.
npx convex run repairs/neo254ProdData:setTeamEra \
  '{"confirm":"NEO254_REPAIR","sport":"Baseball","location":"Los Angeles","name":"Angels","fromYear":1961,"yearsActive":{"from":1961}}' --prod

# 2. Close the Anaheim era at 2015. The two rows carry DIFFERENT full names
#    ("Los Angeles Angels" vs "Los Angeles Angels of Anaheim"), so their
#    dedup keys differ and their eras never collide — steps 1 and 2 are
#    independent and either order works. MEASURED: this row is 2005-open and
#    holds 526 stints. Expect before {"from":2005}, after
#    {"from":2005,"to":2015}, changed true.
npx convex run repairs/neo254ProdData:setTeamEra \
  '{"confirm":"NEO254_REPAIR","sport":"Baseball","location":"Los Angeles","name":"Angels of Anaheim","fromYear":2005,"yearsActive":{"from":2005,"to":2015}}' --prod

# 3. Stints from 2016 on belong to the reopened Angels row. Run this AFTER
#    steps 1-2: both ends are resolved by (name, era start), so the rows must
#    already be dated the way this command names them. MEASURED: exactly 300
#    of the Anaheim row's 526 stints have fromYear >= 2016. Expect
#    "stintsMoved": 300 and "isComplete": true.
npx convex run repairs/neo254ProdData:moveStints \
  '{"confirm":"NEO254_REPAIR","sport":"Baseball","fromTeam":{"location":"Los Angeles","name":"Angels of Anaheim","fromYear":2005},"toTeam":{"location":"Los Angeles","name":"Angels","fromYear":1961},"seasonFrom":2016}' --prod

# 4. The franchise thread carries the current name.
npx convex run repairs/neo254ProdData:renameFranchise \
  '{"confirm":"NEO254_REPAIR","sport":"Baseball","from":"Los Angeles Angels of Anaheim","to":"Los Angeles Angels"}' --prod

# 5. MLB answers to its two leagues and their abbreviations.
npx convex run repairs/neo254ProdData:setLeagueAliases \
  '{"confirm":"NEO254_REPAIR","sport":"Baseball","name":"Major League Baseball","aliases":["American League","National League","AL","NL"]}' --prod

# 6. The four rows the loader ADOPTED under their whole name. Each carries
#    real colours, a real era and (two of them) real stints, and no seed entry
#    names it, so `resplitSeedTeams` cannot reach any of them. All four were
#    confirmed on prod 2026-09-10 to have no split sibling; expect
#    "changed": true from each.
npx convex run repairs/neo254ProdData:splitTeam \
  '{"confirm":"NEO254_REPAIR","sport":"Basketball","currentName":"Los Angeles Clippers","location":"Los Angeles","name":"Clippers"}' --prod   # 1984- , 422 stints

npx convex run repairs/neo254ProdData:splitTeam \
  '{"confirm":"NEO254_REPAIR","sport":"Football","currentName":"Oakland Raiders","location":"Oakland","name":"Raiders"}' --prod              # 1960-2019

npx convex run repairs/neo254ProdData:splitTeam \
  '{"confirm":"NEO254_REPAIR","sport":"Hockey","currentName":"Arizona Coyotes","location":"Arizona","name":"Coyotes"}' --prod                # 2014-2023, 180 stints

npx convex run repairs/neo254ProdData:splitTeam \
  '{"confirm":"NEO254_REPAIR","sport":"Baseball","currentName":"Oakland Athletics","location":"Oakland","name":"Athletics"}' --prod          # 1968-2024

# 7. Every team the SEED knows the parts of and that still holds its whole
#    name. On prod that is the 42 unsplit soccer rows ("Manchester City" →
#    "Manchester" / "City"); they are not listed one by one because this
#    command is what enumerates them.
npx convex run repairs/neo254ProdData:resplitSeedTeams \
  '{"confirm":"NEO254_REPAIR"}' --prod

# 8-10. The three unreachable legacy rows. Each is a pre-NEO-236 row whose
#    name does not compose to the same key as the row that superseded it, so
#    nothing above can reach it. MEASURED on prod 2026-09-10: all three have
#    ZERO cardChecklist references and ZERO entityReviewQueue references
#    (prod holds no cardChecklist rows at all), so the always-blocking checks
#    pass and only the stint policy applies. Expect "outcome": "deleted".

# 8. Basketball "Hawks" — no era, no franchise, a leagueId, and 0 player
#    stints. The move is a no-op today; it is the instruction anyway, and it
#    is what protects against a stint appearing between now and the run.
npx convex run repairs/neo254ProdData:deleteTeam \
  '{"confirm":"NEO254_REPAIR","sport":"Basketball","name":"Hawks","stints":{"kind":"move","to":{"location":"Atlanta","name":"Hawks"}}}' --prod
#    Expect "stintsMoved": 0, "playersChanged": 0, "outcome": "deleted".

# 9. Basketball "Celtics" — same shape, 0 player stints.
npx convex run repairs/neo254ProdData:deleteTeam \
  '{"confirm":"NEO254_REPAIR","sport":"Basketball","name":"Celtics","stints":{"kind":"move","to":{"location":"Boston","name":"Celtics"}}}' --prod
#    Expect "stintsMoved": 0, "playersChanged": 0, "outcome": "deleted".

# 10. Baseball "San Diego State Aztecs men's basketball" — a BASKETBALL team
#    that old cross-sport Wikidata enrichment created under Baseball. It holds
#    1 stint (Tony Gwynn, fromYear 1977). There is no correct baseball row to
#    move that to, so it is dropped. The enrichment bug itself is already
#    fixed on main; this is only its residue.
npx convex run repairs/neo254ProdData:deleteTeam \
  '{"confirm":"NEO254_REPAIR","sport":"Baseball","name":"San Diego State Aztecs men'"'"'s basketball","stints":{"kind":"drop"}}' --prod
#    Expect "stintsDropped": 1, "playersChanged": 1, "outcome": "deleted".

# 11. Disarm, in the same sitting.
npx convex env remove ALLOW_NEO254_REPAIR --prod
npx convex env get ALLOW_NEO254_REPAIR --prod      # expect: not set
```

No `--identity` on any of these — it makes internal functions unreachable
(NEO-214 §2.1).

### Reading the output

- Every result says what changed. `changed: false` on a re-run is the
  expected shape, not a failure.
- `moveStints` must end with `"isComplete": true`. It pages the sport's
  players 500 at a time; if `npx convex run` gives up waiting (it does after
  about five minutes) the action keeps going server-side — re-run the same
  command, which finds nothing left to move and reports `isComplete: true`.
- `splitTeam` reports `before` / `after` as Location + Name parts, with
  `before.location: null` on the run that does the work. A second run reports
  the same parts on both sides with `changed: false`.
- `resplitSeedTeams` lists `skipped` rows with a reason: `ambiguous` (two
  unsplit rows under one name), `colliding` (a split row already exists in an
  overlapping era), `key_mismatch` (the stored dedup key disagrees with the
  row's own name). Each of those is a row for an operator to look at on
  `/admin/teams`; the task never guesses.
- `deleteTeam` reports `outcome: "deleted"` on the run that does the work and
  `outcome: "already_absent"` on a re-run. **A misspelled name reads exactly
  like a re-run**, because "no such row" is also the state a successful delete
  produces — so check the FIRST run's output, where `teamLabel` echoes the row
  it actually found, rather than trusting a later `already_absent`.
- A refusal names the count it found ("found 0", "found 2") and, for a team,
  the eras under that name. Fix the arguments or the data; do not loosen the
  function.

### If a delete refuses

- *"N cardChecklist row(s) still reference it"* / *"N entityReviewQueue
  row(s) still reference it"* — something card-facing points at the row. This
  is never overridable by a flag. Repoint the cards on `/admin/cards`, or
  finish or clear the review, and re-run. If prod has grown checklist rows
  since the measurement above, expect this on a row that used to be clean.
- *"N player(s) still have a stint there"* — you did not pass a `stints`
  policy, so the default refused and named them. Decide whether those stints
  belong on another row (`{"kind":"move","to":{…}}`) or are wrong
  (`{"kind":"drop"}`). Do not guess a destination to make the message go away.
- *"found 2 (…)"* — two rows answer to the name. Add `fromYear` to pick the
  era; the refusal lists the eras it saw.
- *"Expected exactly one destination team"* — the `to` parts do not name one
  row. Remember an omitted `location` means the row's location is EMPTY, not
  "any location": that is what stops `{"name":"Hawks"}` matching the proper
  `Atlanta / Hawks`.

### If step 5 refuses

`Refusing: another league in this sport (American League) already answers
to one of those aliases` means the load created "American League" and/or
"National League" as league rows of their own. That is a data decision, not
something this script makes: decide whether those rows are real leagues
(then drop the alias from the list) or duplicates of MLB (then merge them on
`/admin/leagues` first), and re-run.

## Reusing it

The functions are generic — sport, names and years are all arguments — so
the next bad bulk-load row is fixed with the same commands and different
JSON. What is NOT generic is the arming flag: it is `ALLOW_NEO254_REPAIR` on
purpose, so a deployment armed for this incident cannot be mistaken for one
armed for the reset or the bulk load.

`deleteTeam` is the one to reuse carefully. It is not a delete-team feature;
it is a way to remove a row that no key can reach. Before reusing it, satisfy
yourself the row really is unreachable — a row a lookup CAN find is data, and
data gets fixed with `setTeamEra` / `splitTeam` / `moveStints`, not deleted.

Tests: `apps/web/convex/repairs/neo254ProdData.test.ts` pins the gate on
every function (including the batch mutations a caller could reach directly),
the exactly-one refusals, the merge rule for stints, the collision and
ambiguity skips for the resplit, `splitTeam` over all four adopted prod rows
plus its key-change and collision refusals, `deleteTeam`'s card and review
blocks under every stint policy, and idempotence of all seven.
