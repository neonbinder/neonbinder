# Entity-name re-key (NEO-322)

How to recompute every stored copy of the shared entity-name key after the
normaliser changes, what has to be armed first, how to read the report, and
what is left for an operator afterwards.

Sibling of [`neo236-split-team-locations.md`](./neo236-split-team-locations.md)
and [`neo214-set-builder-admin-scripts.md`](./neo214-set-builder-admin-scripts.md):
an `internalAction` reachable only from a terminal, dry run by default, armed
by an env flag you set and then remove, and idempotent.

**Run it on every deployment, in the same sitting as the deploy that ships the
normaliser change.** NEO-322 is the first such change; the task is written to
be re-run after any later one.

---

## 1. Why it exists

`apps/web/lib/entities/normalize-name.ts` turns a name into the key every
player, team, league and franchise lookup goes through. NEO-322 changed it: a
run of two or more single-letter tokens is now joined, so `C. J. Kayfus`,
`C J Kayfus`, `C.J. Kayfus` and `CJ Kayfus` all key as `cj kayfus`. Before, the
spaced spellings keyed as `c j kayfus` and the same player was offered as a new
person.

Lookups read an index on the **stored** key with the **current** chain. A row
whose key was written by the old chain is therefore unreachable: a card that
says `C. J. Kayfus` now computes `cj kayfus`, misses the row stored under
`c j kayfus`, and the wizard offers to create a duplicate. Production holds
data that stays, so the stored keys are recomputed rather than wiped.

**The window between deploy and re-key is the risk.** From the moment the new
chain is live until this task has applied, any stale row is invisible to its
own exact spelling. Deploy, then run this straight away. Do not leave a
deployment on the new code with the old keys overnight.

---

## 2. What it touches

`rekeyEntityNames:run` (`apps/web/convex/rekeyEntityNames.ts`) walks every
stored copy of the key:

| Table | Field | Recomputed from | On a collision |
|---|---|---|---|
| `players` | `nameNormalized` | `name` | write, report |
| `playerSports` | `nameNormalized` | the player's name (denormalised copy) | write |
| `playerAliases` | `aliasNormalized` | the player's `aliases` list | write, report |
| `teams` | `nameNormalized` | Location + Name, via `teamRowFields` | write, report |
| `teamAliases` | `aliasNormalized` | the team's `aliases` list | write, report |
| `leagues` | `nameNormalized` | `name` (ordered key, no token sort) | **skip**, report |
| `franchises` | `nameNormalized` | `name` | **skip**, report |
| `entityReviewSkips` | `nameNormalized` | `name` | write, report |
| `entityReviewQueue` | `nameNormalized` | `name`, by kind | write, report |

It only ever rewrites these derived keys. It never changes a name, an alias
list, a marketplace field or `lastUpdated`, and it never merges or deletes a
row.

The three side tables (`playerSports`, `playerAliases`, `teamAliases`) are
never written directly. Each has one writer (`syncPlayerSports`,
`syncPlayerAliases`, `syncTeamAliases`), and the re-key rebuilds a player's or
team's rows by calling it. Re-keying a player also rebuilds that player's
side rows in the same step, so by the time the side tables are walked most of
their work is already done (see `applied` in section 5).

A row counts as **changed** when its stored key differs from what the current
chain makes of its name, **for any reason**: the NEO-322 rule, a key from
before diacritic folding (NEO-253), or a key someone wrote by hand.

---

## 3. Two arms

| Arm | What it is | Protects against |
|---|---|---|
| `confirm: "REKEY ENTITY NAMES"` | per invocation | re-running the dry-run command, autocomplete, a typo |
| `ALLOW_REKEY_ENTITY_NAMES=true` | per deployment | a `--prod` typed out of habit |

- **The dry run is the default.** Without `confirm`, or with any other value,
  nothing is written, whatever the environment says. A dry run needs no flag.
- **Only the exact string `true` arms the deployment.** `1` and `TRUE` do not.
- The flag is checked by the entry point and again by **every** write
  mutation, so no other internal caller can get to the writes without it.
- **Correct phrase, deployment not armed:** the call is refused with a
  `ConvexError`. The error data is
  `{ code: "REKEY_NOT_ARMED", message, report }`, where `message` names the
  flag and `report` is the full dry-run report. Nothing is written.

**Never add `--identity`.** `convex run --identity` only finds public
functions, so it fails with "Could not find function". The real gate is that
you need the deployment's admin credential to run an internal function at
all, and prod deploy credentials to reach `--prod`.

---

## 4. The run

Run it on your own dev deployment first, then on production. Every production
command takes `--prod`.

```bash
cd apps/web

# 1. Dry run: writes nothing. Read the report (section 5) before going on.
npx convex run rekeyEntityNames:run '{}'

# 2. Arm the deployment.
npx convex env set ALLOW_REKEY_ENTITY_NAMES true

# 3. Apply.
npx convex run rekeyEntityNames:run '{"confirm":"REKEY ENTITY NAMES"}'

# 4. Disarm, straight away.
npx convex env remove ALLOW_REKEY_ENTITY_NAMES

# 5. Confirm: a dry run must now report toRekey: 0 on every table.
npx convex run rekeyEntityNames:run '{}'
```

Optional arguments, for a very large deployment or a slow run:

| Arg | Default | Meaning |
|---|---|---|
| `pageSize` | 500 for the plan and for single-patch tables; 100 for players, teams and the side tables when applying | Overrides every page size, clamped to 1–500 |
| `maxPages` | 1000 | Pages per table per pass |

---

## 5. Reading the report

```jsonc
{
  "mode": "dry_run",            // or "applied"
  "armed": false,               // true only on an applied run
  "isComplete": true,           // false: a walk stopped at maxPages; see below
  "message": "Dry run: nothing written. …",
  "tables": [
    { "table": "players", "scanned": 4210, "unchanged": 4188,
      "toRekey": 22, "skippedCollision": 0, "refused": 0,
      "applied": 0, "isComplete": true },
    …
  ],
  "collisionCount": 3,
  "collisions": [ … ],          // capped at 200; collisionCount is exact
  "samples": [ … ],             // up to 20 old -> new examples per table
  "refusedCount": 0,
  "refused": [ … ]              // capped at 200; refusedCount is exact
}
```

### `tables`

- `scanned = unchanged + toRekey + skippedCollision + refused`.
- `toRekey` is what an applied run will write.
- `applied` is what an applied run did write. For the **side tables** it only
  counts rows the player or team pass had not already rebuilt, so a side table
  can show `toRekey: 1, applied: 0` after a clean run. That is expected. The
  confirming dry run in step 5 is the real check.

### `samples`

Up to 20 old → new examples per table, so you can check the change is the one
you expect (`c j kayfus` → `cj kayfus`). On an alias table, `newKey` can be
`null` when the replacement could not be told apart. The row is still rebuilt
from the parent's alias list.

### `collisions`

A collision group is two or more rows that will share a key once the re-key
has run, and at least one of them is changing. Two rows that already shared a
key and are not changing are not reported: they are not caused by this run.

Each group has `table`, `scope` (the sport, or for skips and the review queue
the set, batch and kind), `key`, `policy` and `members`. Each member has `id`,
`name`, `oldKey` and `changed`.

| `policy` | Tables | What happened | What to do |
|---|---|---|---|
| `written` | players, teams | Every changed row got the new key. | Open each member on the Players or Teams admin screen. If they are the same person or team, that is a duplicate an operator now has to resolve. If they are different (two real "CJ Smith"s; two eras of one team name), nothing to do: lookups already ask a human when a name matches more than one row. |
| `skipped` | leagues, franchises | The changed rows **kept their old key**. Their readers take the first match and their editors refuse a taken name, so a shared key would hide one row. | On the Leagues or Franchises screen, rename one so the two no longer share a name (or retire the duplicate by hand), then re-run the task. The changed row is reported as `skippedCollision` until you do. |
| `informational` | skips, review queue, aliases | Written. | Usually nothing. On an alias table it means another player or team's main name is the same as this alias in the same sport, so lookups for that string will ask a human. |

### `refused`

Rows the task will not write, each with a `reason`:

- `empty_key`: the name normalises to nothing (only punctuation). Writing an
  empty key would make the row invisible to every lookup, so it keeps its old
  key. Fix the name by hand.
- `empty_name`: a team with no name. Fix it by hand.
- `writer_refused`: a side-table writer refused the row, usually because an
  alias list or a sport list is over its limit. Bring the row back under the
  limit in its admin screen, then re-run.

### `isComplete: false`

A table's walk stopped at `maxPages`. The counts are partial.

- **On a dry run:** re-run with a larger `maxPages`.
- **With `confirm`, when the plan did not finish:** nothing is written. The
  collision picture would be partial, and skipping a colliding league depends
  on it. Re-run with a larger `maxPages`.
- **When the apply did not finish:** what was written stays written. Re-run
  with `confirm` and a larger `maxPages`. Rows already re-keyed now count as
  unchanged.

---

## 6. Idempotent

A second applied run, or the confirming dry run, finds every stored key equal
to its recompute and reports `toRekey: 0` on every table. The only rows still
reported as changed are skipped league and franchise collisions
(`skippedCollision`) and refused rows, both of which wait for an operator.

---

## 7. After a future normaliser change

Any change to the chain in `normalize-name.ts` makes stored keys stale again.
The fix is always this task, run on every deployment straight after the
deploy. Never make the normaliser accept both spellings instead.
