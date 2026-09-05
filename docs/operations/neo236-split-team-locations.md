# Team location split — the one-shot backfill (NEO-236)

How to split every existing `teams` row from one whole franchise name ("San
Diego Padres") into `location` + `name` ("San Diego" + "Padres"), what has to
be armed first, what the output means, and what you finish by hand afterwards.

Sibling of [`neo214-set-builder-admin-scripts.md`](./neo214-set-builder-admin-scripts.md)
and built to the same pattern: an `internalAction` reachable only from a
terminal, gated by an env flag you arm and then unset, dry-runnable, and
idempotent.

**This runs ONCE per deployment, after the NEO-236 PR merges.** Not on a
schedule, not from the UI, and there is no button.

---

## 1. What it does

`splitTeamLocations:run` (`apps/web/convex/splitTeamLocations.ts`) walks every
row in `teams` and, where ESPN can tell it the place part of the name, patches
`name` down to the nickname and writes `location`.

| Field | Before | After |
|---|---|---|
| `name` | `San Diego Padres` | `Padres` |
| `location` | *(absent)* | `San Diego` |
| `nameNormalized` | `diego padres san` | `diego padres san` — **unchanged** |

The key does not move, and that is the whole safety story. `normalizeTeamName`
lowercases, strips punctuation and **token-sorts**, so a word moved from `name`
into `location` normalises to the same string. Every patch recomputes the key
through `teamRowFields` and asserts it came out identical; if it ever did not,
the batch throws and nothing in it lands. That is what lets split and unsplit
rows coexist while the migration runs — every lookup still normalises the
incoming full string and finds the same row.

**ESPN is the only source, and the task never guesses.** No first-token
heuristic: that would turn "Nippon-Ham Fighters" into a team from Nippon-Ham
and give "San Diego State Aztecs" a location it does not have. A row is split
only when ESPN's per-league team list carries a team with the *same dedup key*
and ESPN's own `location` sits at the front of our name as whole words.
Everything else is left whole and listed for you (§5). Wikidata is deliberately
not consulted — its P159/P131 values are corporate headquarters, not team
locations ("Nishi-Shinjuku" for the Chiba Lotte Marines).

**Where the two spell the place differently, our spelling wins.** Prod holds a
row named `St Louis Blues`; ESPN writes `St. Louis`. A character-for-character
prefix test fails on the period, so the task falls back to one extra rule, and
it is a rule rather than a judgement: take as many leading words of *our* name
as ESPN's location has (two, here), and accept the split only if those words
normalise to the same string ESPN's location does. `St Louis` does, so the row
splits — and it stores **`St Louis`**, not `St. Louis`. Writing ESPN's
punctuation onto a name an operator typed would be a rename wearing a split's
clothes. Word count alone is never enough: `Yankees, New York` against ESPN's
`New York` gives leading words `Yankees, New`, which normalise to `new yankees`
and not `new york`, so that row is refused and reported.

---

## 2. Arming: `ALLOW_SPLIT_TEAM_LOCATIONS`

The task refuses to run — **dry run included** — unless
`ALLOW_SPLIT_TEAM_LOCATIONS` is exactly `"true"` on the target deployment.
Unarmed, it throws:

```
The team location split is not armed on this deployment. Set
ALLOW_SPLIT_TEAM_LOCATIONS=true on it first
(`npx convex env set ALLOW_SPLIT_TEAM_LOCATIONS true`), and unset it again
afterwards on production.
```

A near-miss value does not arm it: the check is `!== "true"`, so `"1"` and
`"TRUE"` both refuse.

It is checked **twice** — once at the entry point, so an unarmed run costs
nothing (not even a request to ESPN), and again as the first statement of the
batch mutation that does the patching. Same defence-in-depth argument as
NEO-214's reset: there is no identity check anywhere on this path, so the flag
is the only thing between a caller and a rewritten `teams` table, and it
therefore sits next to the writes rather than only at the front door.

The dry run is gated too, on purpose. It writes nothing but it does walk the
whole table and call a third party, and "armed for writes, unarmed for reads"
is the kind of split rule that rots into a hole.

```bash
cd apps/web
npx convex env get ALLOW_SPLIT_TEAM_LOCATIONS          # default deployment
npx convex env set ALLOW_SPLIT_TEAM_LOCATIONS true     # arm it
```

---

## 3. Running it

From `apps/web`, logged into Convex as `neonbinder@neonbinder.io`.

```bash
cd apps/web

# dev (the default deployment from .env.local / .env.convex)
npx convex run splitTeamLocations:run '{"confirm":"SPLIT","dryRun":true}'
npx convex run splitTeamLocations:run '{"confirm":"SPLIT","dryRun":false}'

# a preview deployment
npx convex run splitTeamLocations:run '{"confirm":"SPLIT","dryRun":true}' \
  --deployment <name>
```

`dryRun` is required, not optional — you have to say which one you are doing.
`confirm: "SPLIT"` is there because `convex run` is one tab-completion away
from a neighbouring function name.

> ### DO NOT ADD `--identity`
>
> It does not authorise this and it **breaks** it: `convex run --identity`
> routes the call through the path that resolves PUBLIC functions only, so an
> `internalAction` comes back "Could not find function". NEO-214's CI seed job
> failed on exactly that.
>
> **What authorises it** is the deployment's own admin credential — `convex
> login` locally, or `CONVEX_DEPLOY_KEY` in CI. An `internalAction` is
> unreachable from any client, so there is no user session to check, and the
> batch mutation deliberately runs no `requireAdmin`; one there would throw
> "Not authenticated" on every legitimate run. Reaching `--prod` requires prod
> deploy credentials, and that is the real boundary.

---

## 4. Production

Deploy order, and it matters: **PR merges → dry run → read the output → real
run → disarm.** The split is only safe once the schema carries `location` and
every reader composes the full name, so nothing runs before the merge.

1. **Backup Now.** Convex dashboard → the prod deployment →
   Settings → Backups → **Backup Now**. NEO-190 §3: a manual backup before any
   deliberate bulk write. This is the only undo that exists.
2. **Arm:**
   ```bash
   cd apps/web
   npx convex env set ALLOW_SPLIT_TEAM_LOCATIONS true --prod
   ```
3. **Confirm the target before you fire:**
   ```bash
   npx convex env get ALLOW_SPLIT_TEAM_LOCATIONS --prod   # expect: true
   ```
   This verifies the arm landed *and* prints the deployment it queried — your
   last chance to notice you are pointed somewhere you did not mean.
4. **Dry run, and actually read it:**
   ```bash
   npx convex run splitTeamLocations:run \
     '{"confirm":"SPLIT","dryRun":true}' --prod
   ```
   Check `espnLeagues` first (§5). Prod holds 78 rows: 77 NFL/NBA/NHL teams
   plus one college side, so expect roughly `split_espn: 77` and
   `skipped_no_source: 1`.
5. **Real run:**
   ```bash
   npx convex run splitTeamLocations:run \
     '{"confirm":"SPLIT","dryRun":false}' --prod
   ```
6. **Disarm, immediately, in the same sitting:**
   ```bash
   npx convex env remove ALLOW_SPLIT_TEAM_LOCATIONS --prod
   npx convex env get ALLOW_SPLIT_TEAM_LOCATIONS --prod   # expect: not set
   ```
7. **Spot-check the app.** `/admin/teams` should read `Padres` on the row with
   `San Diego` beneath it, and the heading on the detail panel should still say
   `San Diego Padres`. Type "San Diego" into a TeamPicker and confirm the team
   still comes back — that is the search index doing its job on
   `nameNormalized`.
8. **Split the leftovers by hand** (§6).

If the run fails partway, re-run it. It is idempotent: rows already split carry
a `location` and are skipped. Do not disarm until it has completed.

---

## 5. Reading the output

```json
{
  "dryRun": true,
  "counts": {
    "scanned": 78,
    "split_espn": 77,
    "skipped_already_split": 0,
    "skipped_no_source": 1,
    "skipped_not_prefix": 0,
    "skipped_key_mismatch": 0
  },
  "espnLeagues": [
    { "sport": "Football", "teams": 32 },
    { "sport": "Basketball", "teams": 30 },
    { "sport": "Hockey", "teams": 32 },
    { "sport": "Baseball", "teams": 30 }
  ],
  "noSource": [
    { "name": "San Diego State Aztecs men's basketball", "sport": "Basketball" }
  ],
  "notPrefix": [],
  "keyMismatch": []
}
```

**Check `espnLeagues` before you check anything else.** A `"teams": null` means
that sport has no `sportConfig.espn`, or the fetch failed — and then *every* row
in that sport lands in `noSource`. A four-second ESPN outage and "these 32 rows
genuinely have no source" produce identical counts, and the first one is a
re-run, not 32 hand splits. `0` means ESPN answered with an empty list, which
is a shape change worth looking into; `null` on a sport you know is mapped
means try again.

The counts sum to `scanned`; every row lands in exactly one bucket.

| Outcome | Meaning | What to do |
|---|---|---|
| `split_espn` | Patched. ESPN named the place part and it was a whole-word prefix. | Nothing. |
| `skipped_already_split` | The row already carries a `location`. | Nothing — this is what makes a re-run a no-op. |
| `skipped_no_source` | No ESPN team in that sport shares this row's dedup key: colleges, NPB/KBO, minor-league affiliates, E2E leftovers, defunct franchises. Listed in `noSource`. | Split by hand (§6), or leave whole if it has no location. |
| `skipped_not_prefix` | ESPN matched the team but its `location` does not sit at the front of our name as whole words, under either test in §1 — "Los Angeles" against a row reading "LA Angels", or "New York" against "Yankees, New York". Listed in `notPrefix` with ESPN's answer beside it. A pure punctuation difference does **not** land here. | Split by hand. Forcing it would be a rename, not a split. |
| `skipped_key_mismatch` | The row's stored `nameNormalized` is not what its own name normalises to — a hand-written or pre-`teamRowFields` key. Listed in `keyMismatch`. | Look at it. Re-deriving the key here would silently repoint every card that resolves through that team, so the task will not do it. |

A `ConvexError` naming a dedup key that "would change" means the invariant
broke and the batch aborted with nothing written. That should be impossible —
report it rather than re-running.

---

## 6. Afterwards: the hand splits

Everything in `noSource` and `notPrefix` is still a correct, whole row: `name`
holds the full string and `location` is absent, which renders identically to
before (full name == short name). Nothing is broken; the rows are just not
split yet.

Split them on **`/admin/teams`**: pick the team, move the place part out of
**Name** into **Location**, save. The form recomputes the key from the composed
full name and refuses if another team already owns it, so a bad split is caught
at save time rather than discovered as a duplicate later.

Leave a row whole when it genuinely has no location — colleges ("San Diego
State Aztecs"), national sides, and corporate-named clubs ("Orix Buffaloes")
carry none, and inventing one is exactly what this task exists not to do.

---

## 7. What not to do

- **Do not run it before the NEO-236 PR is merged and deployed.** The schema
  needs `location` and readers need to compose the full name.
- **Do not add `--identity`** (§3).
- **Do not leave production armed.** A deployment left armed can have its
  entire `teams` table rewritten by anything that reaches the batch.
- **Do not "fix" a `skipped_key_mismatch` row by re-running with a patched
  key.** Look at why the key is wrong first; it is load-bearing for every card
  that resolves through that team.
- **Do not point it at a deployment mid-checklist-commit.** It patches team
  identity fields, and a commit in flight is resolving teams by exactly those
  fields. It is a seconds-long run; do it when the app is quiet.
