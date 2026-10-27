# NEO-285 — college stints for every player: rehearsal and release

**Status:** Operations runbook for NEO-285 (college stints loaded onto the
players NB already holds, football first). Written with the code; run it after
the PR is green.
**Related:** [NEO-285](https://linear.app/neonbinder/issue/NEO-285);
NEO-284 (the college team rows and their aliases, and the armed loader this
extends — read its runbook, `neo284-team-aliases-preload.md`, first); NEO-254
(the player identity key); NEO-190 (backup, restore and preview procedures).
**Server half:** `apps/web/convex/bulkLoad.ts`, section "Player stints"
(`upsertPlayerStints`, `previewPlayerStints`). Its section note is the
protocol; every result field is documented on the validators.
**Wrapper half:** the source pulls (Chadwick register, Lahman, Wikidata
SPARQL, nflverse), the chunking loop and the answers file live in the private
wrapper, as for NEO-284. This runbook calls that script "the driver".

Nothing in this document names a deployment, a secret or a URL.

---

## 0. What changed in the data model

`players.teamYears[].fromYear` is now OPTIONAL. A stint with no `fromYear` is
an **undated** stint: the player was on that team, years unknown. nflverse
names a college and no years, so most football stints land undated; the
Wikidata `P54`/`P580`/`P582` path carries years where they exist. Undated
stints:

- show on the Players admin detail as "Team · years unknown", after the
  dated ones, and in the player pickers and candidate summaries as the bare
  team name;
- are ignored by everything that reasons in seasons (career span, the
  card-year narrowing, the team-on-card suggestion, the spine label default
  and the Players list's team nod);
- survive the Players editor (round-tripped, never re-dated) and a forced
  Wikidata re-enrich (Wikidata never produces one, so it never replaces one).

The widening is additive: every existing row validates unchanged.

## 1. What the loader will and will not do

- **Armed, twice** — `confirm: "BULK_LOAD"` and `ALLOW_BULK_LOAD=true`, as
  for NEO-284. `previewPlayerStints` (a query) needs only the confirm literal
  and can be pointed at an unarmed deployment, including prod.
- **Adopt-only.** It never creates a player. Players are matched by name +
  sport (+ birth year to separate same-name players), the NEO-254 key.
- **Never guesses.** An ambiguous player, or a school that matches several
  teams, is reported and nothing is written for it.
- **The sport filter holds.** A `teamId` in another sport (Wikidata files
  Tony Gwynn's San Diego State membership under the basketball team) is
  refused for that stint only; the rest of the row lands. A `school` never
  resolves to a team whose league is a known non-college league.
- **Gap-fill only.** Nothing is removed, renamed or re-dated. A stint on the
  same team that could be the same one is `present` and a no-op.
- **Never enqueues** enrichment of any kind.

Each stint names its team ONE way:

| field | path | resolution |
|---|---|---|
| `teamId` | Wikidata / register / Lahman, via the NEO-284 dataset's Q-id → the id that key landed on in the NEO-284 results | by id; sport-checked |
| `school` | nflverse's college string; the NBA/NHL cross-checks | `findTeamsByFullName` in the sport (primary name, then NEO-284 aliases), era-narrowed when the stint is dated |

When a `school` matches no team name or alias, the loader tries it as a bare
**location** among the sport's college-league teams only ("Pittsburgh",
"Ohio State"). The exactly-one rule still holds: two college teams at one
location come back `ambiguous-school`. This is why bare city names are NOT
written as aliases: set sync reads aliases, and "Pittsburgh" there must not
mean Pitt.

## 2. Statuses

Per row (`results[].status`):

| status | meaning | your move |
|---|---|---|
| `adopted` / `would-adopt` | the player was found; see `stints` | nothing |
| `no-match` | no player under that name in the sport; or exactly one whose birth year CONTRADICTS (`birthYearMismatch: true`) | nothing — this loader creates no one. Count them; they are players NB has not met yet |
| `ambiguous` + `candidates` | several same-name players and the birth year did not pick one | answer `decision: { adopt: <id> }` in the answers file |

Per stint (`results[].stints[].outcome`):

| outcome | meaning |
|---|---|
| `added` / `would-add` | written (or would be) |
| `present` | the player already has a stint on that team that could be this one; no-op |
| `wrong-sport` | the `teamId` is a team in another sport; refused |
| `missing-team` | the `teamId` does not exist on this deployment (a NEO-284 result from a different deployment) |
| `unresolved` | the school matched no college team in the sport |
| `ambiguous-school` | the school matched several teams (two eras of a program with no years to narrow, or two programs sharing an alias); see `candidates` |
| `cap-reached` | the player already holds 64 stints; nothing more added |

The chunk `summary` totals `adopted`, `stintsAdded`, `stintsPresent`,
`noMatch`, `ambiguous`, `wrongSport`, and lists every `unresolvedSchools` and
`ambiguousSchools` entry with a count. **The unresolved list is never
dropped**: it is the input to the next team preload (D-II/III, juco,
foreign). Fix an `ambiguous-school` either by giving the stint years, or by
removing the shared alias from the wrong program in Team Management.

Chunks are at most 100 players and 8 stints per player. A call that spends
its operation budget stops between rows with `hasMore: true` and `nextKey`;
resume from `nextKey`. Every outcome here is idempotent, so a replayed prefix
is harmless, only slower.

## 3. Rehearsal on the PR's preview

1. PR green, and no further push while rehearsing (a push re-seeds the
   preview).
2. Restore a prod snapshot into the preview (NEO-190 §4.3). The schema change
   is a widening, so the restore validates unchanged.
3. Confirm NEO-284's college teams are present on the restored preview (they
   are on prod once NEO-284 has been released), and that the driver's NEO-284
   results map belongs to the deployment the snapshot came from — a `teamId`
   from elsewhere comes back `missing-team`.
4. **Alias leg first.** Load the driver's school-name aliases (variant
   names like "Mississippi" for Ole Miss, never a bare pro city) onto the
   college teams through the NEO-284 alias loader, so the stints run can
   resolve them.
5. **Dry run** each sport with `previewPlayerStints`, football first, then
   baseball, basketball, hockey. Soccer is out of scope. Answer every
   `ambiguous` player in the answers file.
6. **Arm** the preview, run `upsertPlayerStints`, replaying answers until a
   run reports no new ambiguity.
7. **Prove convergence:** run the whole load again. It must report
   `stintsAdded: 0`. Then disarm and prove it.
8. **Verify** (acceptance):
   - ≥ 90 % of NFL players in NB with an nflverse college carry a stint on
     the matching college team; every unresolved school is in the report
     with a count;
   - spot-check ten players per sport in the Players admin through a local
     Vite on a spare port, including a two-school transfer, a juco → D1 path
     (the juco side lands in `unresolvedSchools` unless the program exists),
     and the Gwynn case (the basketball team refused, the baseball team
     added);
   - a pro career on a spot-checked player is untouched, and the college
     stint shows after it.

## 4. Release to prod

1. Merge only after the preview review and Jason's own pass on it.
2. **Backup Now** on prod (NEO-190 §3).
3. Dry run on prod (`previewPlayerStints`, unarmed) and compare the summary
   to the rehearsal's.
4. Arm prod, run the alias leg, then load sport by sport with the rehearsal's answers file, prove
   convergence (second run: 0 added), disarm, and prove the flag is gone.
