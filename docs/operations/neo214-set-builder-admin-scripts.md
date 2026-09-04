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
npx convex run selectorOptions:resetSetBuilderDataFromCli \
  '{"confirm":"RESET"}' --identity '{"role":"admin"}'
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

### 2.1 The two required flags

**`'{"confirm":"RESET"}'`** — the literal string, validated by
`v.literal("RESET")`. `convex run` is one tab-completion away from a
neighbouring function name and this operation has no undo, so the intent has
to be typed out.

**`--identity '{"role":"admin"}'`** — required, do not drop it. The six batch
mutations each run `requireAdmin`, which reads
`ctx.auth.getUserIdentity()`. A bare `convex run` carries no identity at all,
so without the flag the first batch throws `Not authenticated` and nothing is
deleted. The CLI fills in `subject`, `issuer` and `tokenIdentifier` around
whatever you pass, so `{"role":"admin"}` on its own is enough. Verified
against the dev deployment on 2026-09-04 with the CLI version this repo pins
(`convex@1.45.0`): no flag → `Not authenticated`; `{"role":"user"}` →
`Admin access required`; `{"role":"admin"}` → runs.

> **`--identity` is not a security control.** Anyone who can run `convex run`
> can fabricate any identity they like, admin included. The thing that
> actually gates a deployment is your Convex login and its deploy
> credentials. `requireAdmin` on the batches is defence-in-depth for other
> callers, not the boundary that protects prod.

### 2.2 A preview deployment

```bash
npx convex run selectorOptions:resetSetBuilderDataFromCli \
  '{"confirm":"RESET"}' --identity '{"role":"admin"}' \
  --deployment <preview-deployment-name>
```

The preview name is the Convex deployment a PR's `web-preview` job created —
`pr-pipeline.yml` derives the same slug for its `convex env set` steps. Add
`--typecheck disable --codegen disable` when scripting it, so the run does not
depend on the working tree typechecking.

### 2.3 The one-line wrapper

CI and the local E2E scripts do not call `convex run` directly. The devops
lane owns `apps/web/e2e-baseline.sh`, which wraps the command above, adds
`--deployment "$CONVEX_NAME"` when that is set (CI) and otherwise uses the
default local deployment, and refuses `--prod` in its own arguments:

```bash
apps/web/e2e-baseline.sh reset
```

Prefer the wrapper for anything scripted; use the raw command when you are
targeting a deployment by hand.

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
5. **Run:**
   ```bash
   npx convex run selectorOptions:resetSetBuilderDataFromCli \
     '{"confirm":"RESET"}' --identity '{"role":"admin"}' --prod
   ```
6. **Disarm, immediately, in the same sitting:**
   ```bash
   npx convex env remove ALLOW_RESET_SET_BUILDER_DATA --prod
   npx convex env get ALLOW_RESET_SET_BUILDER_DATA --prod   # expect: not set
   ```
   Step 6 is not optional bookkeeping. A prod deployment left armed has the
   same blast radius as the button NEO-214 deleted, minus the confirmation
   dialog.
7. **Tell the admins.** Everything in those six tables is gone for everyone,
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
- **Do not leave production armed** (§4 step 6).
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

**"Not authenticated" / "Admin access required".** You dropped `--identity`,
or passed something other than `{"role":"admin"}`. §2.1.

**"Could not find function `selectorOptions:resetSetBuilderDataFromCli`".**
The target deployment is running code from before NEO-214, or from a branch
where the function was renamed. Deploy current `main` to it, or pick the right
deployment.

**"I reset the wrong deployment."** If it was prod: NEO-190 §4.1, restore the
backup you took in §4 step 2. If it was dev or a preview: re-sync from the
marketplace in the admin; nothing there is irreplaceable.
