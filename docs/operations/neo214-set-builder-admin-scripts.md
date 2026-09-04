# Set Builder reset — the scripted admin task (NEO-214)

How to wipe Set Builder data on a deployment now that the in-app **Admin
Tools** panel is gone, what has to be armed first, and when a reset is the
wrong tool.

Jason, 2026-09-03: *"Those should just not be there in production. If we want
to do either of those it should be a scripted admin task, not something in the
UI that any admin can hit."*

Before NEO-214 the Set Builder page carried three one-click destructive
buttons for any admin on any deployment. All three are gone. The reset
survives as a single `internalAction` reachable only from a terminal, and this
document is how you reach it. The legacy `wipeLegacyBaseChildren` migration
and the `seedTestTeams` E2E fixture seed were deleted outright — **fixture
teams and players are created through `/admin/teams` and `/admin/players`
now**, by hand, like any other taxonomy row.

---

## 1. What the reset actually does

`resetSetBuilderDataFromCli` (`apps/web/convex/selectorOptions.ts`) deletes
**every row** in six tables on the target deployment:

| Table | What goes with it |
|---|---|
| `selectorOptions` | the whole sport → manufacturer → year → set → variant cascade, and every platform mapping attached to it |
| `cardChecklist` | every card row, including hand-entered and hand-edited ones |
| `cardCrossListings` | the junction rows linking a card to other sets it appears under (NEO-21) |
| `players` | every player row, including career history and Wikidata enrichment |
| `teams` | every team row, including colours (NEO-91/NEO-147) |
| `leagues` | every league row (NEO-156) |

It is not scoped to a set, a sport, or a user. There is no narrower tool: a
set row cannot be deleted individually by design (decision of 2026-08-27 — a
set that goes astray is fixed, never deleted).

It is an action looping paginated internal mutations, so it is **re-runnable**
and safe to run twice; a run against already-empty tables returns all zeros.

---

## 2. Local: reset the dev deployment

This is the common case — clearing dev or a preview between runs. From
`apps/web`, logged into Convex as `neonbinder@neonbinder.io`:

```bash
cd apps/web
npx convex run selectorOptions:resetSetBuilderDataFromCli '{"confirm":"RESET"}'
```

With no deployment flag this targets the deployment named by
`CONVEX_DEPLOYMENT` in `apps/web/.env.local` (`.env.convex` when running under
`npm run dev:backend`). Confirm which one that is before you fire:

```bash
grep CONVEX_DEPLOYMENT apps/web/.env.local
```

On success it prints the per-table counts:

```json
{
  "cardChecklistDeleted": 412,
  "crossListingsDeleted": 5,
  "leaguesDeleted": 3,
  "playersDeleted": 288,
  "selectorOptionsDeleted": 9134,
  "teamsDeleted": 76
}
```

### 2.1 The trust model, and the flag you must NOT pass

> **What gates a deployment is your Convex login and its deploy credentials —
> nothing in the arguments.** `--identity` is not a security control: anyone
> who can run `convex run` can fabricate any identity they like, admin
> included. Reaching `--prod` requires prod deploy credentials. That is the
> real "logged in as me" check, and it is the only one.

Concretely: **the deployment's own admin credential is what authorises this**
— your `convex login` locally, or `CONVEX_DEPLOY_KEY` in CI. An
`internalAction` is unreachable from any client, so there is no user session to
check, and the six batch mutations deliberately carry **no** `requireAdmin`:
with no identity on a CLI run, one there would throw `Not authenticated` on
every legitimate invocation. What they carry instead is the arming flag,
re-asserted next to each delete, so nothing already inside Convex can drain a
table by calling a batch directly (§3).

**Do not pass `--identity`.** It does not authorise this and it *breaks* it:
`convex run --identity` routes the call through the path that resolves
**public** functions only, so an internal function comes back
`Could not find function` even though the deployment plainly has it. NEO-214's
first CI seed job failed on exactly that, and it reproduces on dev — an
internal function with `--identity` is not found, the same function without it
is reached.

**`'{"confirm":"RESET"}'`** is the one required argument — the literal string,
validated by `v.literal("RESET")`. `convex run` is one tab-completion away
from a neighbouring function name and this operation has no undo, so the
intent has to be typed out. That plus the arming flag (§3) is the whole gate.

### 2.2 A preview deployment

```bash
npx convex run selectorOptions:resetSetBuilderDataFromCli \
  '{"confirm":"RESET"}' --deployment <preview-deployment-name>
```

The preview name is the Convex deployment a PR's `web-preview` job created —
`pr-pipeline.yml` derives the same slug for its `convex env set` steps. Add
`--typecheck disable --codegen disable` when scripting it, so the run does not
depend on the working tree typechecking.

### 2.3 The one-line wrapper

CI and the local E2E scripts do not call `convex run` directly. The devops
lane owns `apps/web/e2e-baseline.sh`, which wraps the command above, resolves
its target from `--deployment` → `$CONVEX_NAME` (what CI sets) →
`CONVEX_DEPLOYMENT` in `.env.local` / `.env.convex`, and prints what it is
about to hit before it fires:

```bash
apps/web/e2e-baseline.sh reset
```

**It cannot reach production, and it checks five separate ways in.** It
refuses: `--prod` in its own arguments; a `--deployment` or `$CONVEX_NAME`
that resolves to the prod slug; a `CONVEX_DEPLOYMENT` in `.env.local` /
`.env.convex` that does; a `VITE_CONVEX_URL` in `.env.local` pointing at prod;
and a production `CONVEX_DEPLOY_KEY` in the environment. That last one is the
important one — see §5.

It pins `convex@1.45.0`, matching the CLI `apps/web/package.json` resolves, so
a scripted run and a run you type by hand behave identically. If you bump one,
bump the other.

Prefer the wrapper for anything scripted; use the raw command when you are
targeting a deployment by hand, and §4 when that deployment is prod.

---

## 3. Arming: `ALLOW_RESET_SET_BUILDER_DATA`

The reset refuses to run unless `ALLOW_RESET_SET_BUILDER_DATA` is `"true"` on
the target deployment. Unarmed, it throws:

```
Set Builder reset is not armed on this deployment. Set
ALLOW_RESET_SET_BUILDER_DATA=true on it first
(`npx convex env set ALLOW_RESET_SET_BUILDER_DATA true`), and unset it again
afterwards on production.
```

Check and set:

```bash
npx convex env get ALLOW_RESET_SET_BUILDER_DATA          # default deployment
npx convex env set ALLOW_RESET_SET_BUILDER_DATA true     # arm it
```

**Dev, preview and integration-test deployments keep this set permanently** —
they are reset constantly and the friction would buy nothing there. Production
does not have it, and arms only for the duration of a run (§4).

It is checked **twice**: once at the entry point, so an unarmed run costs
nothing, and again as the first line of each of the six batch mutations that
do the deleting. The duplication is deliberate (NEO-214 security review) —
with no identity check anywhere on this path, the flag is the only thing
between a caller and a drained table, so it sits next to each delete rather
than only at the front door. A future migration or cron reaching a batch
directly hits the same refusal.

> **This changed in NEO-214.** The flag used to gate only the in-app button,
> and the CLI path deliberately skipped it so prod could be reset from a
> terminal without arming a prod-wiping button in the UI. With the button
> deleted that reasoning is gone: the flag's only remaining job is *arm before
> you fire*, which is the friction a production wipe should have. Jason,
> 2026-09-04. If you find the old argument in git history or in an older
> docblock, this supersedes it.

---

## 4. Production

Prod set and card data is hand-built — operator time, entity reconciliation
decisions, admin-confirmed pairings. A re-sync does not reproduce it. Read
[`neo190-convex-backups.md`](./neo190-convex-backups.md) §2.1 first and be
sure a reset is what you want.

1. **Ask whether it is really a reset.** If one set is wrong, re-sync that set
   in the admin and edit inline — NEO-190 §2.1. A reset is for a corrupted or
   abandoned catalogue, not a bad row.
2. **Backup Now.** Convex dashboard → deployment `first-starfish-800` →
   Settings → Backups → **Backup Now**. NEO-190 §3: take a manual backup
   before any deliberate destructive operation. This is the only undo that
   exists.
3. **Close the app.** Every tab, yours and any other admin's. Resetting while
   the Set Selector is open lets the page immediately re-sync the sport column
   and write rows straight back — exactly what happened on dev during NEO-137.
4. **Arm:**
   ```bash
   cd apps/web
   npx convex env set ALLOW_RESET_SET_BUILDER_DATA true --prod
   ```
5. **Confirm the target before you fire:**
   ```bash
   npx convex env get ALLOW_RESET_SET_BUILDER_DATA --prod   # expect: true
   ```
   This does two jobs, and the second is the one that matters. It verifies the
   arm landed, and it proves *which deployment you are actually pointed at* —
   the command prints the deployment it queried. A `true` here from a
   deployment you did not mean to arm is your last chance to notice before the
   next step deletes everything in it.
6. **Run:**
   ```bash
   npx convex run selectorOptions:resetSetBuilderDataFromCli \
     '{"confirm":"RESET"}' --prod
   ```
   No `--identity` — see §2.1.
7. **Disarm, immediately, in the same sitting:**
   ```bash
   npx convex env remove ALLOW_RESET_SET_BUILDER_DATA --prod
   npx convex env get ALLOW_RESET_SET_BUILDER_DATA --prod   # expect: not set
   ```
   Step 7 is not optional bookkeeping. A prod deployment left armed has the
   same blast radius as the button NEO-214 deleted, minus the confirmation
   dialog.
8. **Tell the admins.** Everything in those six tables is gone for everyone,
   and rebuilding it is operator time.

If the run fails partway, re-run it — it is idempotent and picks up where it
stopped. Do not disarm until it has completed.

---

## 5. What not to do

- **Do not run the reset to fix one bad set.** Re-sync it in the admin
  (NEO-190 §2.1). The reset is deployment-wide and discards every other
  admin's work in those tables.
- **Do not use a preview deploy key against production.** `CONVEX_DEPLOY_KEY`
  from `CONVEX_PREVIEW_DEPLOY_KEY` is scoped to previews; combining a preview
  key with `--prod`, or exporting one in a shell where you then type `--prod`,
  is how a "clear the preview" command becomes a prod wipe. Keep the two in
  separate shells.
- **Do not run `e2e-baseline.sh` in a shell with a production
  `CONVEX_DEPLOY_KEY` exported, or with one in `.env.local`.** This is the
  hole none of the script's other guards can see: **the key outranks every
  deployment name it checks.** `--deployment`, `$CONVEX_NAME` and
  `CONVEX_DEPLOYMENT` all describe where you *think* you are pointed, and the
  script validates all three — but the CLI resolves the deploy key first, so a
  prod key sends the run to prod while every printed name still says "dev".
  The script now refuses outright when it detects one; do not defeat that by
  unsetting the check instead of the key. Keep prod keys out of any shell you
  run E2E tooling in.
- **Do not leave production armed** (§4 step 7).
- **Do not run it without a fresh backup on prod.** Not "there was one last
  night" — take one now (NEO-190 §3). The RPO on the automatic daily backup is
  up to 24 hours of operator work.
- **Do not run it with the app open** (§4 step 3).
- **Do not add a client-callable wrapper around it.** That is the thing
  NEO-214 removed; `convex/publicFunctionAuth.test.ts` pins it, and
  `convex/resetSetBuilderData.test.ts` pins the arming gate.

---

## 6. Fixture teams and players

There is no seeding function any more. `teams.seedTestTeams` was deleted in
NEO-214 (Jason, 2026-09-04: *"we can use admin/teams and admin/players to
create teams and players"*). Create what a flow or a manual test needs through
`/admin/teams` and `/admin/players`, the same surfaces an operator uses.

---

## 7. Triage

**"It says it is not armed."** §3 — the deployment does not have
`ALLOW_RESET_SET_BUILDER_DATA=true`. Confirm you are pointed at the
deployment you think you are (`npx convex env get …` with the same
`--deployment` / `--prod` flag you intend to run with) before setting it.

**"Could not find function `selectorOptions:resetSetBuilderDataFromCli`"**
— and the deployment demonstrably has it. **You passed `--identity`.** That
flag makes `convex run` resolve public functions only, so an internal function
vanishes. Drop it; §2.1. This is what broke NEO-214's first CI seed job, and
the error names the wrong problem, so it is worth checking before anything
else.

Otherwise: the target deployment is running code from before NEO-214, or from
a branch where the function was renamed. Deploy current `main` to it, or pick
the right deployment.

**"Not authenticated".** Something under the reset is running an identity
check it should not — a CLI run carries no identity by design (§2.1). Nothing
on this path should produce it; if it appears, a `requireAdmin` has been
reintroduced into `resetSetBuilderDataFromCli` or one of the six batch
mutations. `convex/resetSetBuilderData.test.ts` should have caught it.

**"I reset the wrong deployment."** If it was prod: NEO-190 §4.1, restore the
backup you took in §4 step 2. If it was dev or a preview: re-sync from the
marketplace in the admin; nothing there is irreplaceable.
