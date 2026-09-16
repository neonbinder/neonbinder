# NEO-284 — team aliases and the NCAA D1 / ABL preload: rehearsal and release

**Status:** Operations runbook for NEO-284 (team "also known as" names + the
armed NCAA D1 / ABL team preload). Written with the code; run it after the PR
is green.
**Related:** [NEO-284](https://linear.app/neonbinder/issue/NEO-284);
NEO-254 (the first armed loader, players and teams); NEO-214 (the armed
internal-action pattern); NEO-190 (backup, restore and preview procedures).
**Server half:** `apps/web/convex/bulkLoad.ts` (`upsertLeagues`,
`upsertTeams`, `previewTeams`). Read its header first — the per-row protocol
and every result field are documented there.
**Wrapper half:** the dataset, the chunking loop and the answers file live in
the private wrapper repo and are not part of the monorepo. This runbook refers
to that script only as "the driver".

Nothing in this document names a deployment, a project number, a secret or a
URL. Prod is `--prod`; the branch's Convex preview is "the PR's preview" and
its slug is whatever the PR pipeline's setup job printed.

---

## 0. What the loader will and will not do

The rules are enforced in code; this list is so the operator knows what to
expect from the report, not a checklist to police.

- **Armed, twice.** Every mutation refuses unless the call carries
  `confirm: "BULK_LOAD"` AND the target deployment has
  `ALLOW_BULK_LOAD=true` set. `previewTeams` (a query) needs only the confirm
  literal — it writes nothing — so the dry run can be pointed at an unarmed
  deployment, including prod.
- **Never invents a sport row.** A sport the deployment does not hold is a
  named refusal. Sync the sport first (the set-sync driver's
  `ensureSelectorOptions`), never create one by hand.
- **Never overwrites, never renames.** An adopted row keeps its `name`,
  `location`, colours and franchise. Only ABSENT `leagueId`, `yearsActive`
  and `externalIds.wikidataId` are filled. Aliases are unioned, never
  removed.
- **Never guesses.** Every ambiguity is reported with `key`, nothing is
  written for that row, and the driver asks you. A row adopted THROUGH an
  alias reports `matchedBy: "alias"`, the string it matched on, and a
  `suggestion` — the dataset's Location / Name for that program. The
  suggestion is a report line; rename in Team Management if you agree.
- **Never enqueues.** No Wikidata lookup is scheduled for a league or a team
  this writes (`skipEnrichment` on every league call; teams are not enriched
  at creation anywhere). "Discover" in Team Management remains the human
  remedy.
- **`{ create: true }` is not idempotent.** Record the returned `id` and
  replay that key as `{ adopt: id }`. The driver's answers file does this;
  never edit an answer back to `create`.

## 1. Statuses and what to do with each

| status | meaning | your move |
|---|---|---|
| `created` / `would-create` | no row matched by name or alias; inserted (or would be) with its aliases | read `nearExisting` — rows in the sport sharing the location token. A pair like "Hawaii / Rainbows" beside "Hawaii / Rainbow Warriors" is two historical names, and correct; date the eras and franchise-link them afterwards in Team Management |
| `adopted` / `would-adopt`, `matchedBy: "name"` | one row under that full name, era-compatible | nothing; check `filled` and `aliasesAdded` if curious |
| `adopted` / `would-adopt`, `matchedBy: "alias"` | the row's primary name is one of the dataset's aliases (a raw Wikidata label such as "Washington Huskies baseball"), or the dataset's full name is the row's alias | read `matchedOn` and `suggestion`; rename in Team Management if you want the canonical split. Nothing was renamed |
| `adopted`, `matchedBy: "decision"` | a replayed `adopt` answer | nothing |
| `wikidataMismatch: true` on an adopt | the row already carries a DIFFERENT Q-id | look: the match may be the wrong program. Fix the row's Q-id or answer `create` for the key |
| `aliasesSkipped` on an adopt/create | a decision row carried aliases another row already owns; those were NOT attached | fine, or move the alias by hand if the other row is wrong |
| `ambiguous` + `candidates` (no `matchedOn`) | several eras overlap, or an undated row met a CLOSED incoming era | answer `adopt: <id>` or `create: true`. For an undated prod row and a closed era (ABL 1989–1999 vs an undated "Adelaide Giants"), the usual answer is: let the OPEN era adopt the undated row first (load order below does this), then the closed era creates beside it |
| `ambiguous` + `candidates` + `matchedOn` | exactly one row found ONLY through a shared alias — both sides say "also known as X" and nothing else links them | look at the candidate. Same program → `adopt`; different program → `create` (the shared alias is then skipped and reported) |
| `ambiguous` + `aliasOwnedBy` | an incoming alias is another row's name or alias; nothing written | decide whose alias it is. Remove it from the other row, or answer `adopt`/`create` for this key — owned aliases are skipped on a decided row |

Every result also carries `leagues: [{ name, id }]` for the chunk. `id: null`
means the write run WOULD CREATE that league. For "NCAA" that is the signal
that the sport's NCAA row does not answer to the name — add "NCAA" as an alias
on it in League Management before arming (plan assumption 10). A dry run must
show every league resolving to an existing id before you arm.

## 2. Dataset gate (U7, before anything else)

Regenerate the dataset with the driver's build step and read its summary:

- zero rows whose `location` ends in " and" (the combined men's/women's label
  split);
- zero women's-only program labels;
- max aliases per row ≤ 64, max alias length ≤ 120;
- the two ABL corporate/shared-name clubs ("Geelong-Korea", "Daikyo
  Dolphins") carry no location and the whole string as `name`, per the
  schema's "Orix Buffaloes" precedent.

The loader refuses over-bound aliases and Q-ids loudly (the whole chunk rolls
back); the dataset is where those get fixed, not the answers file.

## 3. Rehearsal on the PR's preview

1. **PR green, and no further push while rehearsing.** A push re-seeds the
   preview. If a re-push becomes necessary, restart from step 2.
2. **Restore a prod snapshot into the preview** (NEO-190 §4.3): either the
   dashboard's restore-from-another-deployment, or `npx convex export --prod`
   followed by `npx convex import --replace-all` against the preview. The
   snapshot zip is a secrets file — download to a scratch directory, import,
   delete. The NEO-284 schema is additive, so the restore validates unchanged
   and `teamAliases` simply starts empty.
3. **Confirm the fixtures the loader depends on** exist on the restored
   preview: the five sport rows (Baseball, Basketball, Football, Hockey,
   Soccer) and each sport's NCAA league row. A missing sport is refused by
   name; a missing NCAA row shows as `leagues: [{ name: "NCAA", id: null }]`
   in the dry run.
4. **Dry run the whole dataset** with the driver in preview mode (it calls
   `bulkLoad:previewTeams`, unarmed) and read the report: every
   `would-adopt` by alias and its suggestion, every `ambiguous`, every
   `nearExisting`, and the `leagues` summary per sport. Write answers into the
   driver's answers file.
5. **Arm the preview**: `npx convex env set ALLOW_BULK_LOAD true` against the
   preview. Load in this order, one sport at a time:
   1. `upsertLeagues` — the NCAA league per sport, then the two ABL leagues
      (the 2009– league and the 1989–1999 league are distinct names in the
      dataset and land as two rows);
   2. `upsertTeams` — NCAA teams per sport;
   3. `upsertTeams` — ABL 2009– clubs, THEN ABL 1989–1999 clubs. This order
      lets an undated prod "Adelaide Giants" be adopted by the open era and
      the closed era create beside it; the other order asks a question
      instead. Either converges; the first asks fewer.
   Replay answers as the driver reports new ambiguities, until a run reports
   none.
6. **Prove convergence**: run the whole dataset once more. The second run must
   report 0 `created` and 0 `ambiguous`. Then **disarm**:
   `npx convex env remove ALLOW_BULK_LOAD` and `npx convex env get
   ALLOW_BULK_LOAD` to prove it.
7. **Verify** (acceptance):
   - a set sync whose checklist carries college and ABL career teams (the
     set-sync driver, `--sport Baseball --year 2026`, the Leaf Baseball
     Nation set, pointed at the preview) parks ZERO NCAA/ABL career teams
     in the review wizard;
   - spot checks on the preview through a local Vite on a spare port:
     **Hawaii** — "Hawaii / Rainbows" untouched, "Hawaii / Rainbow Warriors"
     created beside it and listed under `nearExisting`; **Long Beach
     State** — Dirtbags (Baseball), Beach (Basketball), 49ers 1955–1991
     (Football), each with the shared school aliases; **Miami** — "Miami /
     Hurricanes" and "Miami / RedHawks" distinct, "Miami (FL)" and "Miami
     (OH)" resolve, bare "Miami" parks in baseball and resolves in hockey;
     **ABL** — two league rows; Adelaide Giants / Brisbane Bandits / Perth
     Heat / Melbourne as two eras each; an undated prod "Sydney Blue Sox"
     adopted with years filled; **Wikidata-label row** — "Washington
     Huskies baseball" NOT renamed, aliases unioned, answers to "Washington
     Huskies", "UW Huskies" and "University of Washington", suggestion in
     the report; **LSU** — a wizard row reading "LSU", "Louisiana State
     University" or "LSU Tigers baseball" shows `Link to LSU Tigers` as the
     primary action with "also known as" beneath it.

## 4. Release to prod

1. Merge only after the preview review above and Jason's own pass on the
   preview.
2. **Backup Now** on prod (NEO-190 §3) before anything is armed.
3. **Dry run on prod** (`previewTeams`, unarmed) over the whole dataset and
   diff the report against rehearsal step 4. Every difference must be
   explained by a row an operator added since the snapshot. Re-answer any
   new ambiguity; an `adopt` answer keyed to a snapshot id that prod no
   longer matches is REFUSED by name ("a different team") — the run stops
   with a readable message rather than writing onto the wrong row.
4. Arm prod (`npx convex env set ALLOW_BULK_LOAD true --prod`), load in the
   §3 step 5 order, replay answers, run once more to prove convergence.
5. **Disarm immediately**: `npx convex env remove ALLOW_BULK_LOAD --prod`,
   then `npx convex env get ALLOW_BULK_LOAD --prod` to prove it is gone. Do
   not leave the flag set between steps "just in case".
6. Jason decides whether the set-sync driver syncs Leaf Baseball Nation on
   prod (it writes cards).

## 5. Invocation reference

The driver wraps these; they are listed so a hand run reads the same.

```bash
# Read-only preview, no arming needed. `teams` is ≤ 50 rows.
npx convex run bulkLoad:previewTeams \
  '{"confirm":"BULK_LOAD","sport":"Baseball","teams":[...]}'

# Armed writes. `dryRun: true` runs the same protocol without writing.
npx convex run bulkLoad:upsertLeagues \
  '{"confirm":"BULK_LOAD","sport":"Baseball","leagues":[...]}'
npx convex run bulkLoad:upsertTeams \
  '{"confirm":"BULK_LOAD","sport":"Baseball","teams":[...]}'
```

Run WITHOUT `--identity`: these are internal functions armed by the env flag
and the confirm literal, the NEO-214 shape, and `--identity` cannot reach an
internal function.

**Alias-heavy chunks: send at most 10 rows per call.** Every incoming alias
costs one indexed read plus a `db.get` per hit, so fifty rows carrying the
dataset's 64-alias maximum would crowd one transaction's read budget. The
driver already sizes chunks by total alias count rather than row count; a
hand run should do the same.

Per team row: `key` (the driver uses the Wikidata Q-id), `name`, optional
`location`, `aliases`, `league`, `yearsActive: {from, to?}`, `wikidataId`,
`decision: {adopt: id} | {create: true}`. Convex rejects unknown keys and
`null`, so the driver drops null fields and every dataset column the loader
does not take. **Always send `league`**: a row without one falls back to the
sport's configured top flight, exactly as `teams.findOrCreate` does, which is
wrong for a college side.

## 6. If something goes wrong

- A chunk that throws rolls back entirely; nothing in it landed. Fix the
  cause (usually a dataset bound) and re-run the chunk.
- A row adopted onto the wrong program: the loader wrote only absent fields
  and unioned aliases, so the remedy is Team Management — clear the wrong
  years / Q-id, remove the aliases, and answer `create` for that key on the
  next run.
- Restoring the whole deployment is a last resort and is NEO-190's
  procedure, not this document's. A bad set is re-synced, never restored.
