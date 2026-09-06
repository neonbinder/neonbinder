# Preload datasets (NEO-254)

`mlb.json` and `nfl.json` are **committed build output**. They are the bulk
seed for NeonBinder's `players` and `teams` tables — every MLB player back to
1871 and every NFL player back to 1920, each with dated career stints — and
they are read by exactly one module, `apps/web/convex/preloadPlayers.ts`.

| File | Size | Players | Teams | Leagues |
|---|---:|---:|---:|---:|
| `mlb.json` | ~2.3 MB | 21,227 | 141 | 6 |
| `nfl.json` | ~3.6 MB | 33,248 | 119 | 4 |

**Do not import these anywhere else.** Convex bundles per module against a
32 MiB cap; a second importer puts 5.9 MB of card data into an unrelated
function's bundle.

## These are initial input, not truth

The product invariant applies to datasets exactly as it applies to
marketplaces. Lahman and nflverse **seed** a row when it is created, and their
id is kept on the row (`players.externalIds.lahmanId` / `.nflverseId`) so a
re-run finds what it made last time. After that:

- the loader never overwrites a value already on a row — it only fills in ones
  that are absent;
- it never deletes or renames anything;
- nothing user-facing keys on a dataset value. Deleting both files would leave
  every NB row standing.

## Provenance and licences

### `mlb.json` — the SABR Lahman Baseball Database

> Copyright 1996–2025 by SABR, via generous donation from Sean Lahman.
> Licensed under a [Creative Commons Attribution-ShareAlike 3.0 Unported
> License](http://creativecommons.org/licenses/by-sa/3.0/).

Source page: <https://sabr.org/lahman-database/>. The release used is named in
`mlb.json`'s `source.version` (currently the 1871–2025 release of 10 Dec 2025).

**ShareAlike is unresolved and is a question for Jason.** BY-SA asks that a
derived work be offered under the same licence. `mlb.json` is a derived work,
it is in a public repo, and NeonBinder's own product is not CC BY-SA. The
options are (a) an attribution page naming SABR and the licence, (b) asking
SABR (`sbush@sabr.org`) for written permission for this use, or (c) not
shipping the derived file. Ship nothing to production on the assumption that
(a) suffices without Jason saying so.

Files used: `People.csv`, `Appearances.csv`, `Teams.csv`, `TeamsFranchises.csv`,
`HallOfFame.csv`.

### `nfl.json` — nflverse rosters

> nflverse-data, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
> <https://github.com/nflverse/nflverse-data>

Attribution is the whole obligation, and it ships inside `nfl.json`'s
`source.notes` as well as here.

Files used: `roster_1920.csv` … `roster_2026.csv` **only**. `players.csv` and
`teams_colors_logos.csv` were pulled during the NEO-254 probe and are *not*
inputs to the generator — team identity comes from NB's own curated era table
instead (below), and every fact the loader writes is already on the roster rows.

## The Negro Leagues are excluded, on purpose

Lahman carries SABR-recognised Negro League seasons, sourced from Seamheads'
compilation. Every row whose `lgID` is one of

    NNL  ECL  ANL  EWL  NSL  NN2  NAL          (the recognised major leagues)
    EAS  IND  WES  NAC  INT                    (Lahman's independent/all-star ids)

is dropped from `mlb.json`: 11,457 appearance rows, 509 team-seasons, and 2,784
players who played nowhere else. A player who *also* appeared in the AL or NL
keeps their AL/NL stints and is not dropped.

**Why.** The readme's CC BY-SA 3.0 grant covers the database as a whole and
says nothing specific about redistributing the Seamheads-sourced portion in a
derived work. That is a question, not an answer, and excluding costs one edit
to reverse (`EXCLUDED_LAHMAN_LEAGUE_IDS` in the generator) while shipping and
being wrong does not. This is **not** a judgement about the data — that
portion is the best-recovered record of those leagues there is, and it belongs
in NeonBinder as soon as the licensing is clear.

## Design decisions baked into the files

**One team row per distinct historical name.** "Montreal Expos" (1969–2004)
and "Washington Nationals" (2005–) are two rows; so are "Cleveland Indians"
(1915–2021) and "Cleveland Guardians" (2022–). That is what a card says and
what a stint should read as. `franchise` on each row links them without
merging them.

Where two *unrelated* franchises shared a name, NB still has one row — the
dedupe key is `(nameNormalized, sportId)`, so it cannot have two. The row takes
the years and league of whichever franchise played longest under the name
(so "Baltimore Colts" is the 1953–83 club, not a chimera with the 1947–50 AAFC
one), and the generator prints every such fold on stderr.

**NFL team identity is NB's own, not the source's.** An nflverse team code
means nothing on its own — `BOS` was the Bulldogs, the Braves, the Redskins,
the Yanks and the Patriots; `CHR` was the AAFC Chicago Rockets and then the
1960 AFL Los Angeles Chargers. `apps/web/lib/players/preload/nfl-team-eras.ts`
maps every `(code, season)` to a team, curated from Pro Football Reference's
franchise histories. The generator **fails** on any pair the table does not
resolve, and a unit test proves the committed file is entirely explicable by
the table.

**Player identity.** Baseball uses the Lahman `playerID`. Football uses the
`gsis_id` where the source has one (19,030 players), else a synthetic
`name:<slug>|<birth-date>` key (14,101), else — for 117 rows with neither an id
nor a birth date — `name:<slug>|s<first season>`, flagged `lowConfidence: true`
so the loader can report them.

**Both files carry `location` / `nickname` alongside `name`,** so the NEO-236
Location/Name split is a one-line change in the loader rather than a
re-derivation over 260 team names.

## Regenerating

```bash
cd apps/web
node scripts/build-preload-data.mjs            # both sports
node scripts/build-preload-data.mjs --sport nfl
```

Output is deterministic apart from `source.generatedAt` (a date, not a
timestamp), so a regenerate against unchanged inputs produces a two-line diff.
The script prints its counts and every fold it made to stderr — read them.

Then run the tests, which check the committed files rather than the generator's
opinion of them:

```bash
npx vitest run lib/players/preload scripts/build-preload-data.test.mjs
```

## Refreshing the raw inputs

`data/preload/raw/` is gitignored (~40 MB of third-party CSV). Recreate it as:

```
data/preload/raw/
├── lahman/
│   ├── Appearances.csv  HallOfFame.csv  People.csv
│   ├── Teams.csv        TeamsFranchises.csv
│   └── lahman-readme.txt
└── nflverse/
    └── roster_1920.csv … roster_2026.csv
```

**Lahman** has no scriptable official download — the SABR page at
<https://sabr.org/lahman-database/> serves it from a Box link behind a click.
Download the CSV bundle by hand and unzip the five files plus the readme (the
generator reads the readme for `source.version`). A byte-for-byte mirror that
*is* scriptable lives at <https://github.com/cbwinslow/lahman-database-csv>;
prefer the official page and use the mirror only to verify you got the same
bytes.

**nflverse** publishes stable per-season release assets:

```bash
mkdir -p data/preload/raw/nflverse
for y in $(seq 1920 2026); do
  curl -fsSL -o "data/preload/raw/nflverse/roster_${y}.csv" \
    "https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_${y}.csv"
done
```

A new season means a new `roster_<year>.csv` **and**, usually, an era-table
edit: an expansion team or a rename is a `(code, season)` the table has never
seen, and the generator will refuse to build until it is added.
