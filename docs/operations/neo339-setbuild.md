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
| `draft-set` | no (read-only on NB data) | Drafts a whole set's spec from the server's read-only previews: proposals filled, open decisions left as a fill-in template (§2.4). |
| `build-set` | **yes**, interactively | Terminal only: draft → show it → you type the phrase → apply with `--collect` → you answer what only the run could see → apply again (§2.4). |
| `mcp-smoke` | **yes** | Spawns the MCP server over stdio and runs inspect, plan, apply, inspect against an expectations file. CI only. |
| `oneshot-smoke` | **yes** | Spawns the MCP server and proves the one-shot build: draft, merge with the committed answers, plan, apply, inspect. CI only (§2.4). |
| `confirm-phrase` | no | Offline (no network, no sign-in): prints the confirm phrase `apply` and `nb_apply` need for a spec on a deployment. |

Writes (`apply`, and the MCP write tools) require the **confirm phrase**, bound
to the target AND to the content being written:

```
BUILD <convex host> <scope> <digest>
```

- `<convex host>` is the deployment host, e.g. `<slug>.convex.cloud`.
- `<scope>` is the `scope` field of the spec: the set path for a one-set spec,
  or a declared name such as `e2e-baseline`. For `nb_decide` and
  `nb_build_parallel` it is the set path, for `nb_sl_review_apply` the
  brand-year path.
- `<digest>` is the first 8 hex characters of the SHA-256 of the content as
  canonical JSON (keys sorted, after validation): the parsed spec for
  `apply` / `nb_apply`, the call's own arguments for the other write tools.

A spec run against the wrong deployment, or a spec edited after its phrase was
approved, fails the phrase check before anything is written. Never build the
phrase by hand: `plan` and `nb_plan` return it, a write tool's mismatch error
names it, and `setbuild confirm-phrase --spec <file> --convex-url <url>`
computes it offline (this is what CI and `e2e-seed.sh` use).

How the CLI takes it depends on the auth mode:

- `--auth testing` (previews, local, CI): `--confirm "<phrase>"`, or a prompt
  on a TTY.
- `--auth machine` (production): **always a prompt**. `--confirm` is ignored,
  and without an interactive terminal `apply` refuses (exit 2). Production
  writes are run by the operator in a terminal, or through the MCP tools,
  which Claude Code asks the operator about on every call.

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

Each credential goes only where the confirm phrase's host binds it:

- **machine:** the API key is posted to the Convex **site** URL, which must be
  the `.convex.site` twin of `--convex-url`. A `--convex-site-url` /
  `NB_SETBUILD_CONVEX_SITE_URL` naming anything else is refused (a local
  backend on loopback is the one exception), so machine auth does not work on
  a custom Convex domain.
- **testing:** `--app-url` must be `https://` (plain `http://` only for
  `localhost` / `127.0.0.1` / `[::1]`), and the Vercel bypass header is sent only
  to an https origin.

Production never serves the testing endpoint, and `--auth testing` keeps off it
by construction as well: a `pk_live_` publishable key is refused before any
call, and every minted token's `iss` must be the Clerk Frontend API host the
`pk_test_` key names. There is deliberately no fallback from `VITE_CONVEX_URL`:
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
   `vercel pull` runs under `env -u CONVEX_DEPLOY_KEY -u
   VERCEL_AUTOMATION_BYPASS_SECRET`, so the Vercel CLI never sees the two
   secrets it has no use for.
3. Compute both confirm phrases offline with `setbuild confirm-phrase` (for
   `baseline.spec.json` and `parallel.spec.json`). A spec that does not parse
   fails here, before the reset.
4. `./e2e-baseline.sh reset` against the PR's preview (the shape-checked
   `$CONVEX_NAME`).
5. `setbuild apply --spec .maestro/seed/baseline.spec.json --auth testing
   --app-url <preview> --convex-url https://<slug>.convex.cloud --worker 0
   --paused-platforms "$PAUSED_PLATFORMS" --confirm "$base_phrase"
   --report setbuild-seed-report.json`.
6. `setbuild mcp-smoke --spec .maestro/seed/parallel.spec.json --expect
   .maestro/seed/mcp-smoke.expect.json --paused-platforms "$PAUSED_PLATFORMS"
   --confirm "$par_phrase"`: builds the one seeded parallel through the MCP
   server and checks the result. Its `nb_plan` must return exactly
   `$par_phrase`, which proves the server and the CLI bind the same host,
   scope and spec digest.
7. Counts and duration go to the job summary; the reports are the
   `setbuild-seed` artifact (kept on failure). Every report file, and every
   CLI error, goes through the same scrub as the MCP results (secret
   environment values and anything JWT-shaped).

The enrichment coverage report and the queue enqueue run after, unchanged.

### 2.3 The MCP server

`npm run setbuild:mcp` (stdio). The repo-root `.mcp.json` registers it as
`nb-setbuild`; it carries environment variable **names** only, expanded from
your shell. Eight tools: `nb_inspect`, `nb_plan`, `nb_review_items`,
`nb_draft_set` (read-only on NB data) and `nb_apply`, `nb_decide`,
`nb_build_parallel`, `nb_sl_review_apply` (write). Each
write tool checks the confirm phrase (bound to that call's content) before the
service is touched and returns the expected phrase on a mismatch. The write
tools are on no permission allowlist, so Claude Code asks you for each call.
Never add them to one (`mcp-allowlist.test.ts` fails if you do).

- The read tools run on a query-only client: a mutation or action throws
  before it is sent. `nb_plan` additionally allows the one marketplace
  candidate read (`fetchRawOptions`); `nb_draft_set` allows that and exactly
  the two read-only preview actions (`previewSetStructure`,
  `previewCardChecklist`). None writes NB data; a marketplace adapter may
  refresh its session, as any fetch does.
- A `specPath` is resolved to its real path and must sit inside the
  repository or the directory the server was launched from (`INIT_CWD`);
  a symlink or `..` out of them is refused.
- The server reads `PAUSED_PLATFORMS` from its environment (listed in
  `.mcp.json`), as the CLI's `--paused-platforms` defaults to it.

### 2.4 One-shot set build (`nb_draft_set`, `draft-set`, `build-set`)

An operator says "build 2025 Topps Pristine". The agent calls `nb_draft_set`
with the set's path; the draft comes back with:

- `spec`: the whole set, every **proposal** filled in, every open decision
  left out;
- `proposals`: what the draft filled and why (a sole or pre-selected Base
  candidate, the Reconcile dialog's own auto-matches, an explicit `leave` for
  every pending marketplace set nobody pairs, Group Parallels prefix
  suggestions, Match Cards' keep-all defaults, `create` for a player or team
  no NB row is named like, observed counts, parallel builds). The `leave`
  entries are one spec line per marketplace id (no wildcard), listed as one
  `reconcile-leave` proposal per variant type with the count and the ids;
  `own-set` is never proposed (Jason, 2026-10-11);
- `openDecisions` and `template`: what the operator must answer (a Base side
  with several candidates and no pre-selection; a card disagreement; any
  player or team with an existing NB candidate, never linked by name; a
  checklist the draft could not preview), each as a `<…>` fill-in in the
  template. To make a pending set its own set instead, change its `leave` to
  `own-set` in the spec and raise that type's `expectRows` (and, for an
  Insert type with a `group`, `expectUngrouped`) by one;
- `confirmPhrase`, only when nothing is open. It is not an approval: the
  operator reads the draft and the proposals and gives the phrase.

Then: put the answers into the template, `nb_plan` it, show the operator the
plan and its phrase, and `nb_apply` with that phrase. `nb_apply` collects
(`stopAt: "end"`): the decisions only a write can surface (career teams and
New League steps the lookups stage, a review name the preview could not see)
come back together with one template; answer them and apply again. A set that
does not resolve comes back `unresolved` with near names, plus the brand-year
prepare spec when its Sets were never synced; nothing is created.

On a terminal, `npm run setbuild -- build-set --path "Baseball/2025/Topps/Pristine"`
runs the same loop: it drafts, writes the template (or spec) to `--out`
(default `<path>.build.json`), waits while you answer every `<…>` in that file,
asks for the confirm phrase, applies with `--collect`, and repeats for what the
run collected. It refuses without a terminal, under any auth.
`draft-set --path … --out <file>` only drafts (exit 3 when something needs an
answer).

**Cost.** A draft reads both marketplaces through the previews, one after
another: 1 call for the variant types plus up to 2 per Base / Insert / Parallel
type (`previewSetStructure`, run twice when the Base's SportLots pick differs
from the first read), then per checklist (Base and each insert row) up to 3
calls to confirm the ids, 1 BSC, 1 per SportLots set, and BSC's per-card team
lookup. `marketplaceCalls` in the result is the total the server reported. The
team lookup is most of a big set's wall-clock, so it is bounded per draft by
`teamLookupBudget` (default 2000 cards, `--team-lookup-budget`, 0 = off),
checked before each preview; once spent, later checklists' teams are looked up
when apply fetches them. Nothing is retried. A preview that reads as a refused
session stops every later preview needing that marketplace, and each skipped
checklist is an open decision. Expect minutes for a 100-row set; apply repeats
the fetches (drift between the two becomes an open decision, by design). Every
preview is read-only on NB data, and the result never carries an adapter's
error text, only the platform and the failure class.

Limits worth knowing: a cold set cannot preview a Base mapped to a BSC set
other than the set's own listing (a NEO-189 extra), or any checklist on a set
with no BSC listing; those checklists are open decisions. SportLots sets
another set of the brand holds are read with the same walk the Reconcile
dialog's held-id query makes. Group Parallels suggestions are drafted for
Insert types only. A name is decided at the first checklist apply reaches it
in; a later checklist does not repeat it.

**The live proof (`setbuild-oneshot` in `e2e.yml`).** After `seed`, in
parallel with the runner pool, required by the `e2e` gate. Fixture: 2024
Topps Chrome Black (`.maestro/seed/oneshot.spec.json`, the committed spec;
`oneshot.expect.json`, its expectations). `setbuild oneshot-smoke` drafts it,
requires **no** open decision (the draft settles the whole fixture itself),
merges the draft with the committed spec (any `<…>` from the committed file,
everything else from the draft; `credentials` from the committed file) and
requires the merge to have the committed spec's digest, then `nb_plan`,
`nb_apply` (`stopAt: "end"`, no stop, the expected `reconciled`, `grouped`,
`committed`, `built` counts) and `nb_inspect` (an insert holding a built
parallel; every row of `builtFromBaseType` holding cards; any `after`
expectations). It signs in as its own worker (`ONESHOT_WORKER`), not one a
runner drains the queue with. Its output never names the deployment.

Measuring the fixture (once the server previews are on the PR preview):

1. `npm run setbuild -- draft-set --path "Baseball/2024/Topps/Topps Chrome Black"
   --out oneshot.draft.json --report oneshot.report.json --auth testing
   --app-url <preview> --convex-url https://<slug>.convex.cloud --worker 8`.
2. The report's `openCount` must be 0 (a fixture whose draft leaves a
   decision open is the wrong fixture for this proof). Add the `credentials`
   block the baseline spec uses to `oneshot.draft.json` and commit it as
   `.maestro/seed/oneshot.spec.json`.
3. `plan` it against the same preview; then `apply --collect` on a throwaway
   preview run to read the counts, and commit `oneshot.expect.json`:
   `{ "path", "apply": { "counts": { "reconciled", "grouped", "committed",
   "built" } }, "builtFromBaseType": "Parallel", "after": [] }` (optionally
   `"draft": { "teamLookupBudget": n }`).
4. A red merge later is drift: the failing line names the paths that differ.
   Re-measure in the same PR as the evidence.

Until both files are measured they are placeholders (`"measured": false`) and
the job fails with "fixture not measured yet". A rerun of the oneshot job alone
(without the seed's reset) drafts an already-built set and will not match;
rerun the whole workflow.

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

- `apply` with `--auth machine` runs only in an interactive terminal: it
  ignores `--confirm` and asks for the phrase at a prompt. A script, a pipe or
  an agent's shell gets a refusal (exit 2), never a production write.
- Read the `target` line `whoami` prints, then type the phrase yourself. Do not
  paste a phrase generated by a script; its host and digest are the check.
- **Never export `NB_SETBUILD_API_KEY` in a shell that launches Claude Code**
  unless you mean that session to have production access through the MCP
  tools. The `nb-setbuild` server takes its environment from `.mcp.json`,
  whose `${NB_SETBUILD_API_KEY:-}` expands from the shell Claude Code was
  started in. Run production writes from a separate terminal, or start Claude
  Code with the key deliberately and approve each MCP write call.
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
| Wrong confirm phrase | The host does not match `$CONVEX_NAME`, or the spec changed between the phrase and the write. The step computes the phrase with `setbuild confirm-phrase` from the same spec file, so a mismatch there means the CLI and the server disagree; compare `nb_plan`'s phrase in the `mcp-smoke` output. |
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
