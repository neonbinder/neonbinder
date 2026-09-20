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
(`apps/web/convex/adapters/__fixtures__/enrichment-lookups.json`) answers the
names the E2E seed's 2024 Topps Chrome set surfaces (Base + Future Stars +
Gold Wave, Baseball only — `sportQid: "Q5369"`), instead of a live round-trip
to `query.wikidata.org` and ESPN. Names outside the recording still go live.
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
ALLOW_ENRICHMENT_FIXTURE_CAPTURE=true npx convex run \
  enrichmentFixtures:coverageReportFromCli \
  '{"sportQid":"Q5369","confirm":"CAPTURE_ENRICHMENT_FIXTURES"}' \
  --deployment <this PR's preview>
```

It writes `covered` / `missing` to the job's step summary and, if `missing`
is non-empty, emits exactly one `::warning::` listing the missing names. The
step is `continue-on-error: true` and also tolerates the function not
existing yet on a preview whose Convex-side change hasn't landed (a first
run before the adapter code merges) — either way it **never fails the job**.
A growing `missing` list across runs is the operator signal that the fixture
set has gone stale (a card in the seeded sets that the recording doesn't
cover); it is not a CI gate because the seed already falls back to a live
lookup for anything uncovered, so the suite stays correct either way — just
slower.

## 4. Capture procedure

Capture reads the *current* `players` / `teams` / `leagues` rows for the
sport off a deployment that has just run a seed — those rows' names are what
the seed confirmed, so no separate name list is maintained. Each team/league
row's `externalIds.wikidataId` is passed through as `knownQid`. Run it
against a PR's own just-seeded preview (never against dev mid-session, and
never against prod):

```bash
ALLOW_ENRICHMENT_FIXTURE_CAPTURE=true npx convex run \
  enrichmentFixtures:captureFromCli \
  '{"sportQid":"Q5369","confirm":"CAPTURE_ENRICHMENT_FIXTURES"}' \
  --deployment <this PR's preview> > fixture.json
```

Run **without** `--identity` — these are internal actions armed by the
`ALLOW_ENRICHMENT_FIXTURE_CAPTURE=true` env var plus the `confirm` literal
(the `bulkLoad.ts`/NEO-214 shape), and `--identity` cannot reach an internal
function in the first place.

Then:

1. **Review the diff** against the committed
   `apps/web/convex/adapters/__fixtures__/enrichment-lookups.json` before
   committing. Player search is `LIMIT 1` over an unordered join
   (`wikidata.ts:571-583`), so a capture freezes *an* answer for an ambiguous
   name — that's the intended behaviour, but it means a new or changed entry
   is worth a human glance, not a rubber stamp.
2. **Watch for a transport failure recorded as a no-match.** The adapter
   marks a non-OK/timeout SPARQL response with a trace marker at capture
   time and drops those entries rather than recording them as `null` — if a
   capture run coincided with a live Wikidata outage, re-run capture instead
   of trusting the diff.
3. Commit the regenerated fixture file with the PR (or a follow-up PR) once
   satisfied.

## 5. When to re-capture

- The seed's fixture set changes (a different set, brand, or card range gets
  added to `setup.yaml`'s Base/Future Stars/Gold Wave coverage).
- The coverage warning (§3) shows a growing `missing` list.
- An operator spots a wrong entity in a recorded answer (e.g. during the
  live-proof flow below, or from a §4 review) — re-capture that name's
  neighbourhood and diff before committing.

## 6. The one live-proof flow

One flow deliberately proves the live lane still works end to end, using a
player who is real but is **not** in the recording: `.maestro/flows/admin/
player-live-wikidata-enrichment.yaml` adds **Harmon Killebrew** (Baseball) through
`/admin/players` and asserts the resulting `Wikidata Q[0-9]+` link in the
detail header. Harmon Killebrew is deliberately not a Topps Chrome subject, so this
flow always makes a real Wikidata round-trip regardless of the fixture
switch. A red run here during a live Wikidata outage is expected — rerun
rather than treating it as a product bug (same as any other flow that
depends on a live third party).
