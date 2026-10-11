# NEO-339 — the set-building API, its MCP server and the API-driven E2E seed

**Status:** Operations runbook for NEO-339. The tool is `apps/web/tools/setbuild`
(library + CLI + MCP server); its developer README is
`apps/web/tools/setbuild/README.md`.
**Related:** NEO-214 (the scripted reset this seed starts with,
`docs/operations/neo214-set-builder-admin-scripts.md`); NEO-289 (the enrichment
recording the seed answers from, `docs/operations/neo289-enrichment-fixtures.md`);
NEO-287 (the paused-platform mirror).
**Workflow half:** `.github/workflows/e2e.yml`, `seed` job. Credential recovery
helper: `.github/scripts/preview-testing-creds.mjs`.

Nothing here names a deployment, a project number, a secret value or an
internal URL. Production is "the production Convex deployment"; a PR's backend
is "the PR's preview"; its slug is whatever the PR pipeline's `setup` job
printed as `Convex deployment:`.

---

## 0. What it is

`setbuild` signs in as a real admin and calls the **same public `requireAdmin`
Convex functions the Set Builder UI calls**. It adds no Convex function, HTTP
action or secret. It reads a declarative JSON **spec** (what to build, and an
explicit answer for every operator decision) and:

| Command | Writes? | What it does |
|---|---|---|
| `whoami` | no | Signs in, prints the JWT subject and role, proves an admin-only query succeeds. |
| `inspect` | no | What exists for a set path: Base mapping, card counts, rows. |
| `plan` | no | Lists every decision the spec has to make, with marketplace ids, as a fill-in template. |
| `apply` | **yes** | Builds the spec. Idempotent and resumable. Stops at the first decision the spec does not answer and prints it as a template. |
| `mcp-smoke` | **yes** | Spawns the MCP server over stdio and runs inspect, plan, apply, inspect against an expectations file. CI only. |

Writes (`apply`, and the MCP write tools) require the target-bound **confirm
phrase**:

```
BUILD <convex host> <scope>
```

`<convex host>` is the deployment host, e.g. `<slug>.convex.cloud`. `<scope>`
is the `scope` field of the spec: the set path for a one-set spec, or a declared
name such as `e2e-baseline`. The phrase binds a spec to a target: a spec run
against the wrong deployment fails the phrase check before anything is written.
On a TTY the CLI prompts for it; pass `--confirm "<phrase>"` otherwise.

Marketplace data is input and linkage only (CLAUDE.md "Product invariant"). The
spec names ids; the runner never infers a decision, and never matches on a
marketplace display name.

## 1. Authentication

Two token sources, chosen with `--auth` (or `NB_SETBUILD_AUTH`). Secrets come
from the environment only, never from flags (argv is visible to every process on
the machine).

| `--auth` | For | Needs |
|---|---|---|
| `testing` | Previews and local dev. Mints a session for the worker-N test admin through `POST <app-url>/api/auth/testing`, redeems the sign-in ticket with Clerk, mints the `convex` JWT template. | `TESTING_ENDPOINT_SECRET`, `VITE_CLERK_PUBLISHABLE_KEY` (or `--publishable-key`), `--app-url`, optionally `VERCEL_AUTOMATION_BYPASS_SECRET` for a protected preview. |
| `machine` | Production, and any deployment where the testing endpoint is off. A user-scoped API key. | `NB_SETBUILD_API_KEY`, `NB_SETBUILD_CONVEX_URL`. |

Production never serves the testing endpoint, so `--auth testing` cannot reach
it by construction. There is deliberately no fallback from `VITE_CONVEX_URL`:
an `.env.local` loaded for convenience must never choose the deployment a write
lands on. The target is always `--convex-url` or `NB_SETBUILD_CONVEX_URL`.

## 2. Running it

All commands run from `apps/web` and print `--help` for their flags:

```bash
cd apps/web
npm run setbuild -- help
npm run setbuild -- whoami --auth testing --app-url http://localhost:3000 \
  --convex-url https://<slug>.convex.cloud --env-file .env.local
```

### 2.1 Locally (the seed)

```bash
npm run e2e:local            # start the harness (or just have Vite + a Convex backend up)
npm run e2e:local:seed       # = ./e2e-seed.sh = ./run-e2e-smoke.sh setup
```

`e2e-seed.sh` derives the deployment from the harness's own
`CONVEX_SITE_URL` (not from `CONVEX_DEPLOYMENT`, which can name a different
deployment), runs the scripted reset against it, then `setbuild apply` of
`.maestro/seed/baseline.spec.json` with `--app-url` set to the local Vite
(`APP_URL`, default `http://localhost:3000`). `TESTING_ENDPOINT_SECRET` and
`VITE_CLERK_PUBLISHABLE_KEY` come from `.env.local` (`--env-file`) and must be
the values the running Vite uses. Set `PAUSED_PLATFORMS` to match the target's
`NEONBINDER_PAUSED_PLATFORMS` (the runner fails loudly if they disagree).

The dev deployment is shared by every Claude session on the laptop; a reset
looks exactly like a product bug to another session. Prefer a PR preview
(`CLAUDE.md`, "Debugging a red flow against the PR's own services").

### 2.2 In CI

`e2e.yml`'s `seed` job, after the log capture, the paused-platform mirror and
the enrichment-fixtures flag:

1. `setup-node` (`apps/web/.nvmrc`, npm cache) and `npm ci`.
2. Obtain `TESTING_ENDPOINT_SECRET` and `VITE_CLERK_PUBLISHABLE_KEY`:
   - first `vercel pull --environment=preview --git-branch=<PR branch>` with the
     existing `VERCEL_*` secrets, logging only key presence and length. These
     variables are stored Encrypted and a CLI token that cannot decrypt them
     gets the keys with **empty values**, which is common;
   - otherwise `.github/scripts/preview-testing-creds.mjs` reads the baked
     `VITE_TESTING_ENDPOINT_SECRET` and publishable key out of the PR preview's
     served JS bundle (the same value the old Maestro seed sent from
     `/testing/sign-in`). **Previews only.** No new secret is involved.
   - the testing secret is `::add-mask::`ed before first use and exported to
     that one step only; the publishable key is public by design.
3. `./e2e-baseline.sh reset` against the PR's preview (the shape-checked
   `$CONVEX_NAME`).
4. `setbuild apply --spec .maestro/seed/baseline.spec.json --auth testing
   --app-url <preview> --convex-url https://<slug>.convex.cloud --worker 0
   --paused-platforms "$PAUSED_PLATFORMS" --confirm "BUILD <slug>.convex.cloud
   <scope>" --report setbuild-seed-report.json`.
5. `setbuild mcp-smoke --spec .maestro/seed/parallel.spec.json --expect
   .maestro/seed/mcp-smoke.expect.json`: builds the one seeded parallel through
   the MCP server and checks the result.
6. Counts and duration go to the job summary; the reports are the
   `setbuild-seed` artifact (kept on failure).

The enrichment coverage report and the queue enqueue run after, unchanged.

### 2.3 The MCP server

`npm run setbuild:mcp` (stdio). The repo-root `.mcp.json` registers it as
`nb-setbuild`; it carries environment variable **names** only, expanded from
your shell. Seven tools: `nb_inspect`, `nb_plan`, `nb_review_items` (read) and
`nb_apply`, `nb_decide`, `nb_build_parallel`, `nb_sl_review_apply` (write). Each
write tool checks the confirm phrase before the service is touched and returns
the expected phrase on a mismatch. The write tools are on no permission
allowlist, so Claude Code asks you for each call. Never add them to one
(`mcp-allowlist.test.ts` fails if you do).

## 3. Production usage

Use a **user-scoped API key** from `/profile/api-keys` in the app, belonging to
an admin. Keys are shown once; keep it in Bitwarden, never in a file in the
repo, never in `.env.local`.

```bash
export NB_SETBUILD_AUTH=machine
export NB_SETBUILD_CONVEX_URL=https://<production deployment>.convex.cloud
export NB_SETBUILD_API_KEY=...        # from Bitwarden, this shell only
cd apps/web
npm run setbuild -- whoami             # confirm the target and role first
npm run setbuild -- plan --spec my.spec.json
npm run setbuild -- apply --spec my.spec.json     # prompts for the phrase
```

- Read the `target` line `whoami` prints, then type the phrase yourself. Do not
  paste a phrase generated by a script; its host is the check.
- Run `plan` first and read the open decisions. `apply` re-checks state before
  every write and is safe to re-run, but it writes real catalogue rows.
- Never run `e2e-baseline.sh reset` or the seed spec against production;
  `e2e-baseline.sh` refuses it and the baseline spec's scope will not match a
  production phrase you meant for a different spec.
- Revoke the key from `/profile/api-keys` when the session is done.

## 4. A red seed: fixing it from an open-decision template

A red `Seed baseline` step almost always means `apply` stopped on a decision the
spec does not answer. The step log (and `setbuild-seed-report.json` in the
`setbuild-seed` artifact) prints the decision as a fill-in template: what it is,
the candidate rows with their marketplace ids, and the JSON fragment to add.

1. Download the `setbuild-seed` artifact or read the step log. Find the first
   `OPEN DECISION` block.
2. Decide it (this is the human part: which candidate is right, keep or skip).
   Never pick the first candidate to make it green; a tie is left for the
   operator on purpose (CLAUDE.md invariant 7).
3. Add the answer to `.maestro/seed/baseline.spec.json` (or `parallel.spec.json`),
   naming the row by its marketplace id where the template offers one.
4. Validate it against the same preview without waiting for CI:
   ```bash
   npm run setbuild -- plan --spec .maestro/seed/baseline.spec.json \
     --auth testing --app-url <preview URL> --convex-url https://<slug>.convex.cloud
   ```
   (With the two secrets exported, see §2.2 for where CI gets them.) `plan` is
   read-only. Once clean, push; CI runs the whole thing.
5. If the stop is in the wizard (a new player, team or league the spec has not
   named), the template lists the row and the New Team / New League fields the
   UI would ask for. Add each, exactly as the UI would have created it.

Other reds and their cause:

| Symptom | Cause |
|---|---|
| `Could not obtain TESTING_ENDPOINT_SECRET / VITE_CLERK_PUBLISHABLE_KEY` | `vercel pull` returned blanks AND the preview bundle did not carry them. Check the preview built with the testing secret present; the log shows which chunks were scanned. |
| Sign-in fails with 401/403 from `/api/auth/testing` | Secret mismatch, or the preview is protected and `VERCEL_AUTOMATION_BYPASS_SECRET` was not sent. |
| `pausedSides` disagrees with `PAUSED_PLATFORMS` | The Convex preview env and the repo variable drifted; the mirror step above it should have synced them. Read its summary. |
| Wrong confirm phrase | The spec's `scope` changed, or the host does not match `$CONVEX_NAME`. The step reads the scope from the spec. |
| `mcp-smoke` check failed | The line `FAIL  <label>: <detail>` names which expectation (a count in `mcp-smoke.expect.json`) did not hold. |

## 5. Marketplace drift

The spec names marketplace ids explicitly, so an upstream change (a set
renumbered, a parallel renamed, a card added or removed) turns into an **open
decision or a count mismatch**, never a silent wrong build. That is the design:
marketplaces are input, not truth. To handle drift:

1. Run `plan` against the preview; it shows what the marketplace now returns
   against what the spec names.
2. Edit the spec: update the id, or add the new row's decision. One line per
   change; nothing in the runner keys on a name.
3. If a count in `baseline.spec.json` or `mcp-smoke.expect.json` is simply
   stale (BSC added a card), update it in the same PR as the evidence.

A side whose marketplace ids are absent is skipped, not guessed
(`NEONBINDER_PAUSED_PLATFORMS` and the spec's `whenPaused` fields declare it).

## 6. Enrichment recording capture

A player, team or league name the seed surfaces that the recording
(`apps/web/convex/adapters/__fixtures__/enrichment-lookups.json`) does not cover
goes live to Wikidata/ESPN, which is slower and can surface a career team the
spec does not name; the seed then stops red on that undeclared team. The fix is
two small edits:

1. **Capture** the recording against the PR's just-seeded preview. The
   procedure, arming and disarming of `ALLOW_ENRICHMENT_FIXTURE_CAPTURE` and the
   review rules are in `docs/operations/neo289-enrichment-fixtures.md` §4. Run
   it from the stop point, i.e. after the failed seed has staged the rows.
2. **Name the team or league** in the spec exactly as the template says.

`seed` already prints the coverage report (`covered` / `missing`) to the job
summary; a non-empty `missing` after a green seed means the recording is
getting stale, not that the seed is wrong (NEO-289 §3).

## 7. Cleaning up

`setbuild` leaves no state of its own. The CI seed job's token is minted per run
and expires; `apply`'s only side effects are the Convex rows it writes. After a
local seed, the deployment holds the baseline until the next reset.
