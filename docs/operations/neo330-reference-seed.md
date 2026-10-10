# Reference seed: prod's catalogue in every E2E run (NEO-330)

Every PR's Convex preview starts its E2E run holding production's reference
catalogue: sports, leagues, franchises, teams, team aliases, players, player
aliases and player sports. It arrives in one atomic `npx convex import
--replace` from a private bundle. Flows still create their own fixtures
through the UI; the catalogue is there so the app is exercised at the scale
and with the names it really has.

The scripts live in `apps/web/scripts/reference-seed/`. The bundle is never
committed.

---

## 1. Why the bundle is private

Two reasons, and either one would be enough:

- **It is production data.** It is copied out of the prod deployment.
- **Licences.** Much of the player and team catalogue was bulk-loaded from
  third-party datasets. Their terms require attribution and share-alike, and
  at least one source does not allow its rows to be redistributed at all. A
  dump of those rows cannot go into this public repo or into any public
  bucket.

So the bundle lives in a private bucket. CI reads it through workload
identity, and the object's URI is the repo variable
`NEONBINDER_REFERENCE_SEED_URI`. Read it with
`gh variable get NEONBINDER_REFERENCE_SEED_URI`. This document never names
the bucket. `apps/web/.gitignore` ignores ZIP and JSONL files under the
scripts directory, and a unit test fails if one is ever tracked there. Build
and refresh in a scratch directory outside every checkout anyway.

The scripts print counts, table names, field paths and sport names only.
They never print a row.

## 2. What the bundle holds

`cli.mjs build` cuts it out of a full snapshot export:

| Entry | Contents |
|---|---|
| `selectorOptions/documents.jsonl` | The `level: "sport"` rows only, marketplace ids kept. `children` is cleared because it points at year rows the bundle does not carry. |
| `leagues`, `franchises`, `teams`, `teamAliases`, `players`, `playerAliases`, `playerSports` | Every row, with `_id` and `_creationTime` kept. `createdByUserId` is stripped. |
| `<table>/generated_schema.jsonl` | Copied verbatim from the export. |
| `_tables/documents.jsonl` | The eight tables' **source** table numbers. |
| `sports.json` | One entry per sport row, used by remap mode to match names. |
| `manifest.json` | The format (`neonbinder-reference-seed/2`), generation time, counts, sport names, stripped fields, id-reference shapes and integrity findings. |

Two traps are handled for you:

- **Table numbers.** A Convex id embeds its table's number, and a snapshot
  import keeps the exported number. Production numbered its tables in
  creation order, while a fresh preview numbers them differently. A raw
  import either fails or lands ids on the wrong table. `load` re-encodes
  every id onto the target's numbers, which it reads from a read-only export
  of the target.
- **int64.** In a snapshot every plain JSON number is a float64, and the
  export writes `2005.0`. The importer reads a bare `2005` as int64, which a
  `v.number()` validator rejects. Every writer here emits float notation, and
  `check` refuses a bare integer anywhere in a row.

A reference that was already dangling in production (a player stint pointing
at a deleted team, say) is kept and recorded in the manifest. `check` treats
up to that many as a note. Any more than that is a failure.

## 3. Commands

Run these from `apps/web`. They need Node 18 or later, `zip` and `unzip` on
PATH, and nothing from npm. Every Convex call runs `npx --yes convex@1.45.0`.

```
node scripts/reference-seed/cli.mjs build <export.zip> <bundle.zip>
node scripts/reference-seed/cli.mjs check <zip>
node scripts/reference-seed/cli.mjs load  <bundle.zip> --deployment <name> --sports import|remap [--dry-run] [--yes]
node scripts/reference-seed/cli.mjs clear --deployment <name> [--yes]
```

`npm run reference-seed:<build|check|load|clear> -- …` are the same commands.

**`--sports import`** is the CI mode. The bundle's sport rows are imported
as rows of their own, with their marketplace ids, and they replace the
target's **entire** `selectorOptions` table: years, brands and sets too, not
just sports. The load refuses if the target holds rows in any table the
reset drains that points into `selectorOptions` (`slSetReviews`,
`cardPlayerLinks`, `cardChecklist`, `cardCrossListings`,
`entityReviewQueue`, `checklistCandidates`), because those rows mean the
reset did not run. `selectorSyncStatus` and `entityReviewSkips` also point
into `selectorOptions`, but no reset drains them, so the load only reports
their counts.

**`--sports remap`** is the developer mode. `selectorOptions` is left alone.
Each bundle sport is matched by exact name to the one sport row with that
name on the target. Rows for a sport the target lacks are dropped, along with
their dependants, and references to dropped rows are repaired. The target
needs its sport rows first, and opening the Set Selector once creates them.

**`clear`** empties all eight tables, `selectorOptions` included, with one
atomic import of empty tables. It needs no deployed code (see §6).

`load` refuses a hollow bundle before it contacts Convex. Each of the seven
reference tables needs at least one row, except `playerSports`, which
production legitimately leaves empty (`TABLES_THAT_MAY_BE_EMPTY`). There
must be at least
`MIN_BUNDLE_PLAYERS` (1,000) players and `MIN_BUNDLE_TEAMS` (100) teams,
and import mode needs at least one sport row. Both the manifest counts and
the rows themselves must clear these floors. `build` warns when a bundle
would fall short, and it refuses outright when the export is missing any of
the eight tables.

`load` prints its plan before writing anything: the sport mapping, table
numbers, rows in versus rows kept, repairs and re-encodes. It then runs the
same check on the import ZIP, imports, and verifies the result from a second
read-only export (exact counts, ids on the right table numbers, every sport
id a real sport row). `--dry-run` stops after the plan. It still reads the
target, because the plan needs the target's table numbers.

### Guards

These run on `load` and `clear` before any write:

- `--prod`, the production deployment's name, `dev:`/`prod:` prefixes and
  anything other than a plain `adjective-animal-123` name are refused.
- `CONVEX_DEPLOY_KEY` is checked the way `e2e-baseline.sh` checks it, whether
  it is exported or sitting in `apps/web/.env.local`. A `prod:` or `project:`
  key, or one naming production, is refused. With a key set, `--deployment`
  is required, and a dev key must name the same deployment. CI's preview key
  is passed through to the Convex CLI, because that is how CI authenticates.
- With no key, `convex dashboard --prod` resolves production's name. The
  target must differ from it and must resolve to itself. This is re-checked
  immediately before the import.
- Without `--yes` you retype the deployment name. With no TTY and no `--yes`,
  the command is refused before it contacts Convex.

Exit codes: `0` ok, `1` failed, `2` usage, `3` refused.

### Convex output stays out of the log

CI logs are public. A rejected import prints the document that failed
validation, so every `convex` call here captures its output instead of
passing it through. On success you see only the scripts' own counts. On
failure you see the exit code and the first error line, cut off at
`Object:`, `Validator:` or `Value:`, with nothing from later lines.

## 4. How CI uses it

The E2E seed job downloads `$NEONBINDER_REFERENCE_SEED_URI` to the runner's
temp directory and exports its path as `NB_REFERENCE_BUNDLE`.
`run-e2e-smoke.sh setup` then runs these two steps against the PR's preview:

1. `e2e-baseline.sh reset --except-reference-seed`. This is the scripted
   reset with every table drained except the eight that the import replaces.
2. `cli.mjs load "$NB_REFERENCE_BUNDLE" --deployment "$CONVEX_NAME" --sports import --yes`.

With `NB_REFERENCE_BUNDLE` unset, setup runs the plain full reset as it did
before. A fork PR cannot read the bucket, and the job fails loudly rather
than run without a catalogue.

## 5. Refreshing the bundle

**When:** on demand. Refresh after a bulk load of teams or players, or after
a schema change to any of the eight tables reaches production. Otherwise
refresh roughly once a quarter.

**Who:** a maintainer with prod export rights and write access to the bucket
(Jason today).

Do this in a scratch directory outside every checkout:

```bash
cd apps/web
npx convex export --prod --path <scratch>/prod-export.zip
node scripts/reference-seed/cli.mjs build <scratch>/prod-export.zip <scratch>/reference-bundle.zip
node scripts/reference-seed/cli.mjs check <scratch>/reference-bundle.zip
gcloud storage cp <scratch>/reference-bundle.zip "$(gh variable get NEONBINDER_REFERENCE_SEED_URI)"
rm <scratch>/prod-export.zip <scratch>/reference-bundle.zip
```

- Read `build`'s report before you upload. `DANGLING`, `NOT sport rows`,
  `OUTSIDE` and `REVIEW` lines each deserve a look. A `REVIEW` line means a
  new field that looks user-identifying was not stripped. Add it to
  `STRIP_FIELDS` in `lib.mjs` and rebuild.
- Delete the export **and** the local bundle as soon as the upload succeeds.
  Both are prod data.
- Bucket versioning keeps the previous object. If the new bundle turns CI
  red, restore the prior version instead of debugging under a red suite.
- The next E2E run on every open PR picks up the new bundle. No code change
  is needed.

## 6. Schema rule for the eight tables: additive and optional only

The bundle is a snapshot of production's rows under production's schema, and
every PR's preview imports it under **the PR's** schema. The importer
validates each row, so:

- **Adding an optional field** is always safe. Old rows simply lack it.
- **Adding a required field** cannot seed. Every bundled row lacks the field,
  and the import is rejected. Add the field as optional, backfill production,
  refresh the bundle, and only then make it required. The unit test that
  validates the fixture bundle against `convex/schema.ts` catches this first.
- **Removing, renaming or retyping a field** fails twice:
  - The import rejects rows that still carry the old shape. Stop writing the
    field, migrate production, and refresh the bundle before the PR that
    removes it from the schema.
  - A preview that already holds imported rows refuses the PR's next deploy,
    because Convex validates existing rows on a schema push. Use the `clear`
    recipe below.

### The `clear` recipe (stale-schema hazard)

The symptom is a second or later push to a PR that changes one of the eight
tables. The preview build fails at `convex deploy` with a schema validation
error naming rows in one of those tables. Clear the tables, then rerun:

```bash
cd apps/web
node scripts/reference-seed/cli.mjs clear --deployment <the PR's preview name>
gh run rerun <the failed run id>
```

`clear` imports empty tables, so it works while the preview cannot take new
code. It runs under your own `npx convex login`, or a preview deploy key, for
that deployment. Card rows left in the preview point at removed rows until the
next E2E reset drains them, and `clear` tells you how many there are.

Never push to a PR while someone is testing its preview: the seed resets the
preview on every run.

## 7. Loading your dev deployment

The dev deployment is personal, but every Claude session on your laptop
shares it. Before you load it, make sure no other session is running flows
against dev, or point that session at a PR preview instead. A load replaces
all seven reference tables. To anyone else on dev, that looks exactly like a
product bug.

```bash
cd apps/web
gcloud storage cp "$(gh variable get NEONBINDER_REFERENCE_SEED_URI)" <scratch>/reference-bundle.zip
npm run reference-seed:load -- <scratch>/reference-bundle.zip --deployment <your dev name> --sports remap --dry-run
npm run reference-seed:load -- <scratch>/reference-bundle.zip --deployment <your dev name> --sports remap
rm <scratch>/reference-bundle.zip
```

- Use remap mode on dev. Import mode would replace your whole
  `selectorOptions` table, sets included, and it refuses while any card rows
  exist.
- Your dev deployment needs its sport rows first. Open the Set Selector once.
  Sports the target lacks are dropped and listed in the plan.
- To go back to an empty catalogue, run `e2e-baseline.sh reset`.
