# Prod Convex backups and restore (NEO-190)

How production Convex data is backed up, how it is restored, and — just as
important — when a restore is the wrong tool.

Backups are Convex's built-in periodic backups, configured in the Convex
dashboard. There is **no Terraform for this** and no CI involvement, so this
document is the source of truth for the configuration. If it is ever
rebuilt, rebuild it from here.

---

## 1. Why this exists

Set and card data in production is hand-built: operator time, entity
reconciliation decisions, admin-confirmed pairings. A re-sync does not
reproduce it for free.

The destructive tooling is coarse by design. There is no `deleteSelectorOption`;
a set row cannot be removed once created (decision of 2026-08-27: a set that
goes astray is fixed, never deleted). The only bulk removal is
`resetSetBuilderDataFromCli` (`apps/web/convex/selectorOptions.ts`), which
wipes `selectorOptions`, `cardChecklist`, `cardCrossListings`, `players`,
`teams` and `leagues` in one shot. A mistaken reset, a bad migration, or a
deploy that mangles many rows has no undo other than a backup.

Before 2026-09-02 there was no backup of prod at all.

---

## 2. The four facts that shape everything here

### 2.1 A bad set is a re-sync, not a restore

A restore is deployment-wide. Restoring last night's backup to fix one set
also discards every collection edit, sale, shipment and other admin's set
work recorded since then, for everyone.

**If one set is wrong: re-sync it from the marketplace in the admin and edit
inline.** It is faster, it is safer, and any sales already recorded against
the set survive. Do not reach for the restore button to fix data that a
re-sync can rebuild.

Restore is for the disaster case only: a mistaken reset, a migration or
deploy that corrupts many tables, or a deployment that is lost or wiped.

### 2.2 A backup is every table, and nothing else

| In the backup | Not in the backup — where it actually lives |
|---|---|
| Every table, with `_id` and `_creationTime` preserved so cross-table references hold | Convex environment variables (`ENCRYPTION_KEY`, `GOOGLE_APPLICATION_CREDENTIALS_B64`, `NEONBINDER_BROWSER_URL`, …) — see NEO-178 |
| Component tables: the `wikidataPool`, `fastPreprocessPool` and `heavyPreprocessPool` workpool queues and worker state | Deployed code and cron registrations — redeploy from `main` |
| | Pending scheduled functions |
| | GCS buckets (`neonbinder-prizes`, placeholder uploads) |
| | Clerk users, GCP Secret Manager, Vercel environment |

The environment variables matter most. `platformCredentials` rows are
ciphertext under prod's `ENCRYPTION_KEY`; a restored deployment without that
key has credentials it cannot read. Restoring into the **same** deployment
keeps its env vars, so this only bites when restoring elsewhere.

### 2.3 A backup is a secrets file

The backup contains `platformCredentials` (encrypted), `authRefreshTokens`,
`authSessions`, `authVerifiers` and `users`. A downloaded backup zip must be
treated like a credential dump: keep it off shared drives, and delete it as
soon as the task that needed it is done.

### 2.4 The app uses no Convex file storage

There are zero `ctx.storage` or `_storage` references in `apps/web`. Every
binary asset lives in GCS or Vercel Blob. The backup's "include file
storage" option is therefore **off**, and turning it off loses nothing.

---

## 3. Configuration (dashboard — not IaC)

Production deployment: `first-starfish-800`.

Dashboard → deployment → **Settings → Backups**:

| Setting | Value | Why |
|---|---|---|
| Backup automatically | **on** | Any admin can build a set at any time; a backup that depends on a human remembering is not a control. |
| Frequency | **daily** | Disasters are noticed in hours. Daily bounds the loss at one day. |
| Include file storage | **off** | See §2.4. |
| Retention | 7 days (fixed by Convex for daily backups) | Long enough for the disaster case. Longer retention is NEO-206's concern. |

Requires the **Convex Pro** plan; the team has been on Pro since 2026-09-02.
If the plan ever lapses, periodic backups stop silently — see §8.

Manual backups: **Backup Now** on the same page. Also kept 7 days. Use it
before any deliberate destructive operation — a migration, a
`resetSetBuilderDataFromCli` run, a restore.

**Verify it is still on** whenever you are in the dashboard for anything
else: the Backups page should show a backup less than two days old.

---

## 4. Procedures

### 4.1 Disaster restore into prod

1. **Stop the bleeding.** If the cause is still running (a migration, a
   script), stop it. Ask admins to stop editing.
2. **Backup Now** first. Convex's own guidance: restoring "is a destructive
   operation that wipes your existing data… generate an additional backup
   before doing a restore." This preserves the broken state in case the
   diagnosis is wrong.
3. Backups page → pick the newest backup from **before** the damage → menu
   → **Restore** → confirm.
4. Post-restore checklist:
   - Data spot-check: open the admin, load a set that was recently edited,
     confirm it is there.
   - Crons: dashboard → Schedules → Cron Jobs shows the four entries from
     `apps/web/convex/crons.ts`. If not, redeploy (`release.yml` on a
     `main` push, or a no-op empty commit).
   - Workpools: the restored component tables may hold in-flight jobs from
     the moment of the backup. Dashboard → Data → the three
     `*PreprocessPool` / `wikidataPool` components; confirm `work` and
     `pendingStart` drain or clear them.
   - Env vars: `npx convex env list --prod` — unchanged by a same-deployment
     restore, but confirm.
5. Everything written between the backup and the restore is gone. Tell the
   admins what window was lost.

RPO: up to 24 hours (daily backup), or however old the last manual backup
is. RTO: seconds today, see §5.

### 4.2 Restore into a scratch deployment (drills, inspection)

Convex can restore a backup into any deployment on the same team. Use this
to inspect old data without touching prod, or to rehearse §4.1.

1. Create a scratch target: `npx convex deployment create` from
   `apps/web` (or use a PR preview deployment — isolated and self-expiring).
   Never the shared dev deployment: the backup carries prod users, sessions
   and workpool queues.
2. Deploy current `main` to it so the schema matches.
3. Scratch deployment → Settings → Backups → **Restore** → "from another
   deployment" → pick the prod backup.
4. Expected, not bugs: prod users cannot log in (different Clerk instance);
   `platformCredentials` are undecryptable (different `ENCRYPTION_KEY`);
   workpool queues may try to run prod's queued jobs — clear them.
5. Delete the scratch deployment when done.

### 4.3 CLI fallback (dashboard unavailable)

```bash
cd apps/web
npx convex export --prod --path ./prod-snapshot.zip          # ~3 s today
npx convex import --deployment <target> --replace-all ./prod-snapshot.zip -y
rm ./prod-snapshot.zip                                          # it is a secrets file (§2.3)
```

`--replace-all` wipes the target first, including tables absent from the
zip. Zip imports preserve `_id`. Needs a Convex login as
`neonbinder@neonbinder.io`; if the CLI says "You don't have access to the
selected project", `npx convex logout && npx convex login`.

### 4.4 What not to do

- Do not restore to fix one set (§2.1).
- Do not use `npx convex import --table <t> --replace` on a set-data table
  in prod. It replaces the whole table and discards every other admin's
  concurrent work in it.
- Do not download backups to a shared location.

---

## 5. Drill of record

| Date | Who | Backup | Restore | Data size | Result |
|---|---|---|---|---|---|
| 2026-09-02 | Jason | ~2 s | ~10 s | ~1 MB raw (prod barely populated; dev export the same day was 574 KB zipped / 3.6 MB raw, 134 files) | Clean. No surprises. |

Both numbers will grow with the data. Measured row sizes from the same
day's export: ~966 bytes per `cardChecklist` row, ~615 per
`selectorOptions` row raw. Re-run the drill when the database has grown by
an order of magnitude, or yearly, whichever comes first, and add a row here.

---

## 6. Cost and the scaling line

Every backup reads the whole database and bills as **database bandwidth**
(Pro includes 50 GB/month, then $0.12/GB). At today's size that is nothing.

| Database size | Daily backup, bandwidth/month | Cost/month |
|---|---|---|
| 100 MB | 3 GB | $0 (inside the included 50 GB) |
| 5 GB | 150 GB | ~$12 |
| 20 GB | 600 GB | ~$66 |

When the database passes roughly **5 GB**, revisit: switch to weekly, or
pick up NEO-206, whose design includes moving to Convex streaming export
(incremental) instead of full snapshots.

---

## 7. Triage

**"Did last night's backup run?"** Dashboard → Backups. Newest entry should
be under 24 hours old. If not: check the plan is still Pro (Team settings →
Billing), then the toggle in §3.

**"Something is badly wrong with prod data."** Ask first: is it one set, or
many tables? One set → §2.1, re-sync in the admin. Many tables, or a
deploy/migration/reset just ran → §4.1.

**"I need to see what a row looked like yesterday."** §4.2 into a scratch
deployment, or `npx convex export` and read the JSONL locally (then delete
it).

---

## 8. Known gaps

- **No alert when the periodic backup stops.** Convex does not emit one.
  Mitigation is the "verify it is still on" habit in §3. A real alert is
  part of NEO-206.
- **Env vars are not backed up.** Restoring into a fresh deployment needs
  them re-set by hand. NEO-178 is the ticket for making prod's env
  reproducible.
- **Single vendor.** Backups live in the same Convex account as the data.
  Decided 2026-09-02 that an off-vendor copy is not worth building at
  today's scale; parked as NEO-206 for when it is.
- **7-day retention.** Fine for disasters, which are noticed in hours. Not
  a tool for finding out what a row looked like a month ago.
