# Bulk player/team preload — the scripted admin task (NEO-254)

How to load ~21,000 baseball players and ~33,000 football players, with dated
career stints, into a deployment's `players` and `teams` tables; what has to be
armed first; and when NOT to run it.

Jason, 2026-09-06: *"lets add the nflverse and lahmans pre load to our script"*
— and earlier (NEO-236): *"I actually plan to bulk load as many teams and
players as we possibly can before we start loading sets."*

Same shape as the Set Builder reset (`neo214-set-builder-admin-scripts.md`):
an `internalAction` reachable only from a terminal, behind an environment flag
and a confirmation literal, with a dry run in front of it. A bulk write of
tens of thousands of globally-shared reference rows is not something a
misdirected click should be able to start.

---

## 1. What it does

`preloadPlayers:run` (`apps/web/convex/preloadPlayers.ts`) reads the committed
datasets in `apps/web/data/preload/` and, for one sport per invocation:

| Phase | Writes |
|---|---|
| 1. Leagues | Finds-or-creates the leagues the dataset's teams played in. The sport's OWN league goes through `leagues.resolveDefaultLeagueId`, so it lands on the existing "Major League Baseball" / "National Football League" row rather than minting a rival. Historical leagues (Federal League, AAFC, AFL, APFA, American Association…) get their own rows at `level: "major"`. |
| 2. Teams | One row per distinct historical name — "Montreal Expos" **and** "Washington Nationals", "Cleveland Indians" **and** "Cleveland Guardians" — each with `yearsActive` and a league. |
| 3. Players | One row per source player, with `name`, `birthYear`, `teamYears` (dated career stints pointing at the team rows above), `isHallOfFame` where the source says so, and the source id in `externalIds.lahmanId` / `.nflverseId`. |

**It never overwrites.** An existing team keeps its league and years; an
existing player keeps its name, career, birth year and Hall-of-Fame flag. Only
fields that are *absent* get filled in. The datasets are initial input, not
truth — see `apps/web/data/preload/README.md` and the product invariant.

**It never deletes or renames anything.**

**It is safe to re-run.** Every player it creates carries its source id on an
index, so a second run finds its own rows and creates nothing.

**Where it cannot tell which existing row is the same person, it writes
nothing and logs it.** Lahman alone has 558 names shared by two or more
players. Those are reported as `playersSkippedAmbiguous` and resolved by hand
(or through the review wizard), never guessed.

---

## 2. When NOT to run it

- **Never on a deployment Jason is testing a preview against.** This adds tens
  of thousands of rows to shared reference tables; a player picker that had
  four "Smith"s now has forty, and every screenshot and E2E expectation taken
  against that preview changes underneath him. Ask first, exactly as with a
  push to a PR whose preview is in use.
- **Not before the sport is synced.** The sport-level `selectorOptions` row is
  created by the marketplace sync and is never invented here. Without it the
  run reports every row as `skippedNoSport` and writes nothing — a real answer,
  but a wasted run.
- **Not on production without a backup.** Take a **Backup Now** first
  (`neo190-convex-backups.md` §3). Nothing here deletes, but a bulk write is
  still a bulk write.

---

## 3. Run it

From `apps/web`, logged into Convex as `neonbinder@neonbinder.io`.

### Step 0 — arm the deployment

```bash
cd apps/web
npx convex env set ALLOW_PRELOAD_PLAYERS true            # dev / the default deployment
npx convex env set ALLOW_PRELOAD_PLAYERS true --prod     # production
```

Every mutation asserts this independently, not just the entry point. Without
it, the run refuses and names the flag.

### Step 1 — dry run, and read it

```bash
npx convex run preloadPlayers:run \
  '{"sport":"baseball","confirm":"PRELOAD","dryRun":true}'
```

Writes nothing, anywhere. It reports what it *would* do — which is how you
find out that the sport is not synced, or that a deployment already carries
most of these players, before you write a row.

### Step 2 — for real, one sport at a time

```bash
npx convex run preloadPlayers:run '{"sport":"baseball","confirm":"PRELOAD"}'
npx convex run preloadPlayers:run '{"sport":"football","confirm":"PRELOAD"}'

# a preview deployment
npx convex run preloadPlayers:run '{"sport":"baseball","confirm":"PRELOAD"}' \
  --deployment <name>

# production, only after arming
npx convex run preloadPlayers:run '{"sport":"baseball","confirm":"PRELOAD"}' --prod
```

**Do not add `--identity`.** It does not authorise this and it breaks it:
`convex run --identity` resolves PUBLIC functions only, so an internal function
comes back "Could not find function". There is no user identity on a CLI run
and none is wanted — the deployment's own admin credential (`convex login`
locally, `CONVEX_DEPLOY_KEY` in CI) is the auth, and reaching `--prod` requires
prod deploy credentials.

### Step 3 — disarm

```bash
npx convex env remove ALLOW_PRELOAD_PLAYERS --prod
```

Dev and preview deployments can keep it set. Production arms and disarms around
the run.

---

## 4. Reading the summary

```json
{
  "dryRun": false,
  "sport": "baseball",
  "leaguesCreated": 6,
  "teamsCreated": 141,
  "teamsAdopted": 0,
  "playersCreated": 21031,
  "playersAdopted": 178,
  "playersSkippedAmbiguous": 18,
  "playersSkippedNoSport": 0,
  "truncatedStints": 0,
  "droppedStints": 0,
  "nextStart": null
}
```

| Field | What it means, and what to do about it |
|---|---|
| `leaguesCreated` | New `leagues` rows. Expect 6 (baseball) / 4 (football) on a fresh deployment, 0 on a re-run. |
| `teamsCreated` / `teamsAdopted` | Created vs. matched an existing row by name. On a re-run: 0 created, all adopted. |
| `playersCreated` | New `players` rows. |
| `playersAdopted` | Matched an existing row — either one this task created on an earlier run (found by source id) or an unambiguous NB row it filled in. |
| `playersSkippedAmbiguous` | **The one to read.** Nothing was written for these. Each is logged as `preload_player_skipped_ambiguous` with a `reason`: `several_same_birth_year` (two existing rows share the name and the year), `undated_candidates` (a candidate could be them and nothing says so), `different_source_id` (the only candidate already carries another source player's id — adopting it would merge two people), or `too_many_candidates` (more rows share the name than the bounded scan reads). `npx convex logs` (or the dashboard) lists them. Resolve by hand in `/admin/players`; re-running will not fix it. |
| `playersSkippedNoSport` | Non-zero means the sport has never been synced. Nothing was written. Sync the sport and run again. |
| `truncatedStints` | Players whose career exceeded the 64-stint cap; the earliest 64 were kept. Expect 0 — the longest real career in either dataset is 18. Non-zero means the datasets changed shape and someone should look. |
| `droppedStints` | Stints whose team row could not be found. Expect 0 after a normal run; non-zero in a dry run is expected (the teams it would have created do not exist). |
| `nextStart` | `null` when the whole file was processed. A number means the action stopped cleanly and there is more to do — either it hit its 6-minute budget, or a chunk found no transaction headroom (logged as `preload_chunk_no_headroom`). Re-run with `"start": <that number>`. It is a resume point, not an error. |

### Resuming

```bash
npx convex run preloadPlayers:run \
  '{"sport":"baseball","confirm":"PRELOAD","start":12800}'
```

The team phase re-runs regardless (four cheap, convergent mutations), so the
stints below always have teams to point at. Re-running from `0` is equally
safe — just slower.

---

## 5. Afterwards

**Preloaded players count as enriched.** They carry `teamYears` and, for Hall
of Famers, `isHallOfFame`, and `enrichPlayer`'s creation-only guard (NEO-203)
skips any player already carrying an enrichment marker. That is correct:
Wikidata is the fallback for players the preload *missed*, not a second pass
over these. Admin → **Re-enrich from Wikidata** (the `force: true` path) still
reaches any individual player.

**Expect more same-name collisions in the review wizard.** With 21,000
baseball players loaded there are several "Bob Allen"s, and the checklist
prelude will route an ambiguous name to the entity-review wizard with the NB
candidates listed rather than linking the first match. That is NEO-254's other
half, not a regression.

**Regenerating the data files** is a separate job with its own instructions —
`apps/web/data/preload/README.md`. Nothing in this runbook rebuilds them; the
loader reads what is committed.
