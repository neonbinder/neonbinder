# NEO-289 — recorded enrichment lookups for the E2E seed

**Status:** Operations runbook for NEO-289. Written with the code; run the
capture procedure after the PR is green and the first seed has run.
**Related:** [NEO-289](https://linear.app/neonbinder/issue/NEO-289); NEO-287
(the `NEONBINDER_PAUSED_PLATFORMS` mirror this borrows its per-run-write
reasoning from); NEO-184 (why a preview env var must be written every run,
not assumed from a dashboard default); NEO-214 (the armed
internal-action pattern the capture/coverage actions follow).
**Server half:** `apps/web/convex/adapters/enrichmentFixtures.ts` (the gate,
key and lookup wrapper) and `apps/web/convex/enrichmentFixtures.ts` (the
`captureFromCli` / `coverageReportFromCli` internal actions). Read those
files' headers for the exact behaviour; this document only covers operating
them.
**Workflow half:** `.github/workflows/e2e.yml`, `seed` job.

Nothing in this document names a deployment, a project number, a secret or a
URL. Prod is `--prod`; the branch's Convex preview is "the PR's preview" and
its slug is whatever the PR pipeline's setup job printed; dev is "dev" (the
one shared deployment covered by NEO-249/288).

---

## 0. What this is

The entity-review wizard enriches players, teams and leagues from Wikidata
and ESPN exactly as it does in production — nothing a user sees changes.
What changes is where the *answer* to a lookup comes from on dev and PR
previews: a committed recording
(`apps/web/convex/adapters/__fixtures__/enrichment-lookups.json`) answers,
instead of a live round-trip to `query.wikidata.org` and ESPN, the lookups of
two batches, both Baseball only (`sportQid: "Q5369"`):

- the names the E2E seed's 2024 Topps Chrome set surfaces (Base + Future
  Stars + Gold Wave), captured with §4's procedure;
- since NEO-330, every lookup the review batch of 1996 Line Up Venezuelan
  Winter League makes (`checklist-wizard-link-team-saves-alias.yaml`): 200
  players, the 8 clubs, the 2 career teams and the league the wizard stages,
  211 of 211, added with §4a's method.

Names outside the recording still go live.
**Production never reads the recording** — see the two-env gate below.

This exists because the seed's own arithmetic doesn't fit inside CI's wait:
~336 rows can need up to two 10s fetch timeouts each, through a 5-wide pool,
against a live SPARQL endpoint whose health is out of our control. A miss or
transport failure recorded as `null` in the fixture is a genuine no-match
answer, not a gap — see §4 for what to do if capture ever records a
transport failure by mistake.

## 1. The switch and its two-env gate

`NEONBINDER_ENRICHMENT_FIXTURES=1`, read at lookup time by
`apps/web/convex/adapters/enrichmentFixtures.ts`. It is honoured **only when
`TESTING_RESET_SECRET` is also set** on that deployment (the same
belt-and-braces shape as `convex/testing.ts:60`). Prod has neither var, so a
stray `NEONBINDER_ENRICHMENT_FIXTURES=1` there is inert — the gate check
fails closed and the code falls through to a live lookup with one structured
warning logged, never a silent recording read.

A hit is honoured only when the recorded `wikidataId` matches the caller's
`knownQid` (or the record carries none); a mismatch is treated as a miss and
goes live. The key is `${kind}|${sportQid}|${normalised name}` — `knownQid`
is not part of the key.

## 2. How each environment gets it

- **PR previews:** `e2e.yml`'s `seed` job sets it on THIS PR's Convex preview
  every run, unconditionally, immediately before the seed step — the same
  reason the `NEONBINDER_PAUSED_PLATFORMS` mirror (NEO-287) does the same
  thing: a branch-reused preview otherwise keeps whatever a dashboard default
  was last set to (NEO-184), so "set once by hand" silently drifts. The write
  is read back and the job fails loudly on a mismatch rather than seeding
  slow/flaky and calling it fine.
- **Dev:** a one-off, by hand:
  ```bash
  npx convex env set NEONBINDER_ENRICHMENT_FIXTURES 1
  ```
  Dev is the one Convex deployment shared across every concurrent Claude
  session on this laptop (not a shared *server* — NEO-249/288). **Announce
  before setting it** the same way any dev-affecting env change should be
  announced, so a concurrent session isn't surprised that its Wikidata
  lookups suddenly answer from a Baseball-only Topps Chrome recording.
- **Prod:** never set either var. See §1.

## 3. Coverage report (informational, non-blocking)

After the seed step, `e2e.yml` runs a coverage check:

```bash
npx convex run \
  enrichmentFixtures:coverageReportFromCli \
  '{"sportQid":"Q5369","confirm":"CAPTURE_ENRICHMENT_FIXTURES"}' \
  --deployment <this PR's preview>
```

Coverage is read-only and internal, so it takes only the `confirm` literal —
no deployment env var to arm.

### Which names it checks

Only the names a run on that deployment actually looked up, not every row
the deployment holds. Since NEO-330 every CI preview carries the reference
catalogue, and almost none of those rows is ever looked up, so "every row"
would bury the real gaps under catalogue names. The names come from three
places a lookup leaves a trace (the header of
`apps/web/convex/enrichmentFixtures.ts` has the detail):

- `players`, `teams` and `leagues` rows of the sport **created since the
  run's boundary**: a row the review wizard creates was looked up when it
  was staged, and a player or league created on an admin page is looked up
  at creation;
- `entityReviewQueue` rows still open (the commit deletes its own batch);
- `entityReviewSkips` rows whose set is in the sport: a skipped name was
  looked up but never becomes a row.

The **boundary** is the `_creationTime` of the oldest `year` row, because a
name reaches the wizard only through a set, and the seed's catalogue load
leaves `selectorOptions` holding sport rows only. Catalogue rows keep their
source `_creationTime`, so all of them are older than that. Pass
`"since": <ms since the epoch>` to set the boundary yourself. Do that on a
deployment whose year rows are older than its catalogue load (a developer
deployment loaded with `--sports remap`).

One gap is known: a staged name the operator **linked** to an existing row
leaves no row of its own, so it is not checked. §4a adds those by hand.

### What it returns

`covered`, `missing` (`"<kind>: <name>"` per name the committed recording
lacks), `total`, the boundary it used (`since`, `sinceSource`: `arg`,
`firstYearRow` or `none`), and `truncated` / `truncatedSources`. Every source
is an index range from the boundary capped at 2,000 rows, so a read never
scales with the catalogue. If a source hits the cap, the report still
returns. `covered`/`missing` then cover only the rows read, `truncated` is
`true`, and `truncatedSources` names the cut sources. The report never
throws on truncation, so it cannot fail the job.

The workflow writes `covered` / `missing` to the job's step summary, with
the raw report (including `truncated` and the boundary) in a collapsed
block. If `missing` is non-empty it emits exactly one `::warning::` listing
the missing names. The step is `continue-on-error: true` and also tolerates
the function not existing yet on a preview whose Convex side hasn't landed,
so it **never fails the job**. A non-empty `missing` list, or one that grows
across runs, is the operator signal that the recording has gone stale: a
name a run asked about that the recording would send live. It is not a CI
gate, because an uncovered name still falls back to a live lookup and the
suite stays correct, only slower.

The step runs right after the seed, so it sees the seed's lookups. It does
not see lookups the runner jobs' flows make later in the same run.

## 4. Capture procedure

Capture looks up, live, the same names the coverage report checks (§3):
the ones a run on that deployment looked up. It works on a catalogue-loaded
preview, because catalogue rows are outside the boundary. Run it against a
PR's own just-seeded (or just-run) preview, never against dev mid-session
and never against prod. Each team/league row's `externalIds.wikidataId`, and
each staged row's Wikidata id, is passed through as `knownQid`.

```bash
# From apps/web. Arm on the DEPLOYMENT (a shell env var never reaches the Convex runtime):
npx convex env set ALLOW_ENRICHMENT_FIXTURE_CAPTURE true --deployment <this PR's preview>
npx convex run \
  enrichmentFixtures:captureFromCli \
  '{"sportQid":"Q5369","confirm":"CAPTURE_ENRICHMENT_FIXTURES"}' \
  --deployment <this PR's preview> > capture.json
npx convex env remove ALLOW_ENRICHMENT_FIXTURE_CAPTURE --deployment <this PR's preview>
# Fold it into the committed file (additions only; see step 1 below):
npx tsx scripts/merge-enrichment-capture.ts capture.json
```

Run **without** `--identity` — capture is an internal action armed by the
deployment env var `ALLOW_ENRICHMENT_FIXTURE_CAPTURE=true` plus the `confirm`
literal (the `bulkLoad.ts`/NEO-214 shape), and `--identity` cannot reach an
internal function in the first place. Disarm afterwards; never leave the flag
set on a deployment.

Capture **refuses** when the name list is truncated (more than 2,000 rows in
one source since the boundary). The error names the source and the boundary.
Past that size the list is no longer one run's names. Pass `"since"` set to
the start of the run you mean to capture. `offset`/`limit` page a long list,
and `since` is accepted alongside them. Capture each page to its own file
(`'{"sportQid":"Q5369","confirm":"CAPTURE_ENRICHMENT_FIXTURES","offset":300,"limit":100}'`
→ `capture-300.json`) and pass every page file to one merge run.

`fixture.entries` in a capture is a **list** of `{ key, entry }` sorted by
key, not the file's keyed object. A key embeds the looked-up name, and Convex
refuses a field name outside printable ASCII in a function's return value, so
before NEO-346 one accented name (`Ciego de Ávila`) failed its whole page. The
merge script builds the keyed object on the laptop.

Then:

1. **Merge, never overwrite.** `capture.json`'s `fixture.entries` hold one
   run's names, and the committed
   `apps/web/convex/adapters/__fixtures__/enrichment-lookups.json` holds every
   recorded batch. Writing `fixture` over the file would drop every batch
   recorded on another run. Merge with one command, from `apps/web`:
   ```bash
   npx tsx scripts/merge-enrichment-capture.ts capture.json [capture-100.json …]
   ```
   It validates every captured entry the way the runtime validates the file
   (the key is `fixtureKey(kind, sportQid, name)`, ids are QIDs), refuses a
   capture for another sport, adds only the keys the file lacks, re-sorts,
   and writes the file in its committed format (Python
   `json.dumps(indent=2, ensure_ascii=True)`, `\uXXXX` escapes), so the diff
   is additions only. A key the file already holds with a **different**
   answer keeps the committed answer and is listed; re-run with `--replace`
   when you mean to re-capture those (that is the point of re-capturing).
   `--dry-run` reports without writing. It also prints the capture's
   `skippedTransport` names, which were not recorded. Logic and tests:
   `apps/web/convex/adapters/enrichmentFixtureMerge.ts`,
   `apps/web/convex/enrichmentFixtureMerge.test.ts`.
2. **Review the diff** against the committed file before committing. Player
   search is `LIMIT 1` over an unordered join (`wikidata.ts:571-583`), so a
   capture freezes *an* answer for an ambiguous name. That's the intended
   behaviour, but it means a new or changed entry is worth a human glance,
   not a rubber stamp.
3. **Watch for a transport failure recorded as a no-match.** The adapter
   marks a non-OK/timeout SPARQL response with a trace marker at capture
   time and drops those entries rather than recording them as `null`; they
   are listed in `skippedTransport`, and their committed entries (if any)
   stay as they were after the merge. If a capture run coincided with a live
   Wikidata outage, re-run capture instead of trusting the diff.
4. Commit the merged fixture file with the PR (or a follow-up PR) once
   satisfied.

## 4a. Adding one set's lookups without `captureFromCli` (NEO-330)

This is how the Venezuelan Winter League batch was recorded. It runs the
same live lookup code the capture runs, from a laptop, and changes nothing on
any deployment: no env var is armed and nothing is written. §4 now works on
a catalogue-loaded preview too. Use this method when you would rather not
arm a deployment, or when the batch's linked names matter: §4 cannot see
those (§3).

1. **Get the exact names the batch stages.** Run the flow that commits the
   set once on the PR's preview (an ordinary E2E run), then read the set's
   `entityReviewSkips` rows read-only (index
   `by_selector_option_and_kind_and_name`). They hold the raw `name` of every
   row the operator SKIPPED: the per-player strings the wizard staged, not
   the card's name (an "A / B" card stages two names). Rows the flow LINKED
   are not there; add those names by hand from the flow. Staged career teams
   and leagues carry a `knownQid` (their `source.wikidataId`); keep it with
   the name, because the lookup is keyed on the name but a hit is honoured
   only when the recorded `wikidataId` equals it (§1), and a recorded `null`
   is a miss for a caller with a known QID.
2. **Get the sport context**: the sport row's `sportConfig` (its `espn` and
   `wikidata` blocks), read-only.
3. **Look every name up with the live bodies.** In an `.mts` script under
   `npx tsx` (a `.ts` script outside the app is compiled as CommonJS and
   top-level `await` fails), call `lookupPlayerEnrichmentLive(name, sport,
   trace)`, `lookupTeamEnrichmentLive(name, sport, knownQid, trace)` and
   `lookupLeagueEnrichmentLive(name, sportQid, knownQid, trace)` from
   `apps/web/convex/adapters/wikidata.ts`, each with a fresh
   `newLookupTrace()`, five at a time (the deployment pool's width). Turn each
   answer into an entry with `toFixtureEntry` and key it with `fixtureKey`
   (`apps/web/convex/adapters/enrichmentFixtures.ts`). **Drop every entry
   whose trace has `transportFailed` set** and look it up again: that is
   capture's own guard against recording an outage as a no-match (§4, step
   2). About 200 names took ~48 s.
4. **Prove coverage offline before committing.** In the same script set
   `NEONBINDER_ENRICHMENT_FIXTURES=1` and a dummy `TESTING_RESET_SECRET` in
   `process.env`, then call `readFixture(kind, sportQid, name, knownQid)` for
   every lookup the batch makes, with the merged file in place. The count of
   misses must be zero.
5. **Merge without disturbing the file.** Add only keys that are absent,
   never change an existing entry, and re-sort the keys. Python's
   `json.dumps(data, indent=2, ensure_ascii=True) + "\n"` reproduces the
   committed file byte for byte, so the diff shows only the new entries.
   The simplest way is to have the script write its entries as a capture
   file (`{"fixture":{"version":1,"capturedAt":"…","sportQid":"Q5369",
   "entries":[{"key":…,"entry":…}, …]}}`) and run §4 step 1's merge command
   on it, which does exactly this.
   `apps/web/convex/enrichmentFixtureFile.test.ts` pins the key format, the
   entry shape and the sort, and keeps the live-proof player (§6) out.
6. **Review the new entries** as §4 step 1 says: player search is `LIMIT 1`,
   so an ambiguous name freezes one answer.

The preview answers from the new entries only after its bundle is rebuilt,
because the JSON is imported at build time: the next push to the PR.

## 5. When to re-capture

- The seed's fixture set changes (a different set, brand, or card range gets
  added to the scripted seed's spec, `.maestro/seed/baseline.spec.json` —
  `npm run setbuild`, docs/operations/neo339-setbuild.md; before NEO-339 this
  was `setup.yaml`'s Base/Future Stars/Gold Wave coverage).
- A recorded flow fixture changes: a different set, or a different batch on
  the same set, for `checklist-wizard-link-team-saves-alias.yaml`. Redo §4a
  for the new batch.
- The coverage warning (§3) shows a growing `missing` list.
- An operator spots a wrong entity in a recorded answer (e.g. during the
  live-proof flow below, or from a §4 review) — re-capture that name's
  neighbourhood and diff before committing.

## 6. The one live-proof flow

One flow deliberately proves the live lane still works end to end, using a
player who is real but is **not** in the recording: `.maestro/flows/admin/
player-live-wikidata-enrichment.yaml` adds **Vladislav Tretiak** (Hockey) through
`/admin/players` and asserts the resulting `Wikidata Q[0-9]+` link in the
detail header. The recording is Baseball-only and Tretiak never played in the
NHL, so he is in neither the recording nor the NEO-330 reference catalogue, and
this flow always makes a real Wikidata round-trip regardless of the fixture
switch. (Harmon Killebrew held this slot until NEO-330: the catalogue holds
him.) A red run here during a live Wikidata outage is expected — rerun rather
than treating it as a product bug (same as any other flow that
depends on a live third party).
