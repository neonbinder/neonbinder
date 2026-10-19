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
| `attention` | no | Everything on a set or brand-year still waiting on a person: cards that need you, names to check, rows to mark on-card or sticker, SportLots sets to sort, sync notices (§2.5). |
| `fix` | **yes** | Answers what `attention` listed, through the Set Builder's own saves, from an answers file (§2.5). |

Writes (`apply`, and the MCP write tools) require the **confirm phrase**, bound
to the target AND to the content being written:

```
BUILD <convex host> <scope> <digest>
```

- `<convex host>` is the deployment host, e.g. `<slug>.convex.cloud`.
- `<scope>` is the `scope` field of the spec: the set path for a one-set spec,
  or a declared name such as `e2e-baseline`. For `nb_decide` and
  `nb_build_parallel` it is the set path, for `nb_sl_review_apply` the
  brand-year path, for `nb_fix` the path it was given (set or brand-year).
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

Under either mode, `--app-url` / `NB_SETBUILD_APP_URL` is also the web app the
tool's Set Builder links open on (a message that sends the operator to the Set
Builder carries a link to the row it is about). Set it with `--auth machine`
too; without it the links are root-relative (`/admin/set-builder?sport=…`)
and every result that carries links says so in `linksNote`: "Links are paths
only: set NB_SETBUILD_APP_URL to the app address for this deployment."

**Pair it with the Convex URL, per environment.** `NB_SETBUILD_APP_URL` is the
origin of the web app that serves the deployment `NB_SETBUILD_CONVEX_URL`
points at, never another one: a link on the wrong app opens a different
deployment's Set Builder, where these ids mean nothing, so the tool never
guesses it.

| Target (`NB_SETBUILD_CONVEX_URL`) | `NB_SETBUILD_APP_URL` |
|---|---|
| The production deployment | `https://<the production app>` |
| A PR's Convex preview | `https://<that PR's preview app>` |
| A deployment a local Vite serves (`VITE_CONVEX_URL`) | `http://localhost:<that Vite's port>` |

`.mcp.json` passes both through from the environment (`${NB_SETBUILD_APP_URL:-}`),
so set the pair in the shell that starts the session.

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
# a Vite wired to the target deployment must be running (APP_URL)
CONVEX_NAME=<deployment slug> APP_URL=http://localhost:3002 \
  npm run test:e2e:seed      # = ./e2e-seed.sh
```

`e2e-seed.sh` takes the deployment from `CONVEX_NAME` (required; never from
`CONVEX_DEPLOYMENT`, which can name a different deployment), runs the
scripted reset against it (`./e2e-seed-reset.sh`; with `NB_REFERENCE_BUNDLE`
set, also the NEO-330 catalogue load), then `setbuild apply` of
`playwright/seed/baseline.spec.json` and of `playwright/seed/parallel.spec.json`
(the one seeded base parallel, which CI builds through `mcp-smoke`) with
`--app-url` set to the local Vite (`APP_URL`, default `http://localhost:3000`). `TESTING_ENDPOINT_SECRET` and
`VITE_CLERK_PUBLISHABLE_KEY` come from `.env.local` (`--env-file`) and must be
the values the running Vite uses. Set `PAUSED_PLATFORMS` to match the target's
`NEONBINDER_PAUSED_PLATFORMS` (the runner fails loudly if they disagree).

The dev deployment is shared by every Claude session on the laptop; a reset
looks exactly like a product bug to another session. Prefer a PR preview
(`CLAUDE.md`, "Debugging a red spec against the PR's own services").

### 2.2 In CI

`e2e.yml`'s `seed` job (and, identically, `seed-mobile` before the mobile pass), after the log capture, the paused-platform mirror and
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
4. `./e2e-seed-reset.sh` against the PR's preview (the shape-checked
   `$CONVEX_NAME`, exported to the step): `e2e-baseline.sh reset`, and,
   with the downloaded bundle in `NB_REFERENCE_BUNDLE`, the NEO-330
   reference-catalogue import (check → scoped reset → `convex import
   --replace`; `docs/operations/neo330-reference-seed.md` §4). The apply
   below therefore runs against prod's players, teams and leagues: its review
   stages only names the catalogue lacks and same-name players (the pick
   step, `Which <name> is this?`), and the spec's answers for every other name
   are moot no-ops.
5. `setbuild apply --spec playwright/seed/baseline.spec.json --auth testing
   --app-url <preview> --convex-url https://<slug>.convex.cloud --worker 0
   --paused-platforms "$PAUSED_PLATFORMS" --confirm "$base_phrase"
   --report setbuild-seed-report.json`.
6. `setbuild mcp-smoke --spec playwright/seed/parallel.spec.json --expect
   playwright/seed/mcp-smoke.expect.json --paused-platforms "$PAUSED_PLATFORMS"
   --confirm "$par_phrase"`: builds the one seeded parallel through the MCP
   server and checks the result. Its `nb_plan` must return exactly
   `$par_phrase`, which proves the server and the CLI bind the same host,
   scope and spec digest.
7. Counts and duration go to the job summary; the reports are the
   `setbuild-seed` / `setbuild-seed-mobile` artifacts (kept on failure). Every report file, and every
   CLI error, goes through the same scrub as the MCP results (secret
   environment values and anything JWT-shaped).

The enrichment coverage report runs after, unchanged. There is no Playwright
project in the seed (main's `setup` project, the UI port of the retired
`setup.yaml`, is replaced by this step); the shards' `bootstrap` project
still seeds each shard's own account.

### 2.3 The MCP server

`npm run setbuild:mcp` (stdio). The repo-root `.mcp.json` registers it as
`nb-setbuild`; it carries environment variable **names** only, expanded from
your shell. Ten tools: `nb_inspect`, `nb_plan`, `nb_review_items`,
`nb_draft_set`, `nb_attention` (read-only on NB data) and `nb_apply`,
`nb_decide`, `nb_build_parallel`, `nb_sl_review_apply`, `nb_fix` (write). Each
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
  left out. The default summary result carries `template` instead while
  anything is open (the spec plus a fill-in per open decision), never both;
- `proposals`: what the draft filled and why (a sole or pre-selected Base
  candidate, the Reconcile dialog's own auto-matches, an explicit `leave` for
  every pending marketplace set nobody pairs, Group Parallels prefix
  suggestions, Match Cards' keep-all defaults, `create` for a player or team
  no NB row is named like, observed counts, parallel builds). The `leave`
  entries are one spec line per marketplace id (no wildcard), each with the
  marketplace's `name` for the set (display only; matched by id), so a BSC
  set and a SportLots set that belong together can be paired from the draft
  alone: replace their two `leave`s with one `sync.pairs` entry. One
  `reconcile-leave` proposal per variant type gives the counts; `own-set` is
  never proposed (Jason, 2026-10-11);
- `leftUnasked`: per variant type, the Pending sets the draft does not list.
  SportLots lists a whole brand-year at the insert level, so every fetch
  returns every product of the brand-year (about a thousand sets for 2014
  Topps). Only the sets inside the Reconcile dialog's own SportLots filter are
  listed (names starting with the set's name, the set's name less its brand,
  or the Base's SportLots name; the dialog hides the rest behind "Show all");
  the rest are counted, with a short sample. A set another variant type of
  the set pairs is not listed under this one either. Apply leaves both kinds
  in Pending without asking, exactly as Save does, and says so in the step's
  detail;
- `openDecisions` and `template`: what the operator must answer (a Base side
  with several candidates and no pre-selection; a card disagreement; any
  player or team with an existing NB candidate, never linked by name; a
  checklist the draft could not preview), each as a `<…>` fill-in in the
  template. A card disagreement is answered with a side (`choose: "bsc"` or
  `"sportlots"`), or, when the pair is two different cards that share a
  number, by moving it to `pairing.unlink` (the Match Cards dialog's Unlink:
  both cards are kept apart). A player name that only one side of an unanswered card
  disagreement carries (BSC "Alex Guerrero" vs SportLots "Alexander
  Guerrero") is never pre-filled: the review asks about it only if that side
  is chosen, so its fill-in names the conflict it rides on, and an answer for
  the side not chosen is a reported no-op at apply. A player that shares its name with existing NB players gets a
  fill-in offering `{"link": "<name>", "birthYear": <year>}` and each
  candidate's birth year (`José Rodriguez (born 2001) [<id>]`): a link by a
  shared name alone stops as ambiguous, and `birthYear` names the one born
  that year (none or several born that year stops too, listing every
  same-name birth year). To make a pending set its own set instead, change its `leave` to
  `own-set` in the spec and raise that type's `expectRows` (and, for an
  Insert type with a `group`, `expectUngrouped`) by one;
- `autographFormats` (NEO-345): every drafted checklist whose cards carry
  "AU", which the Set Builder would ask "on card or sticker?", with `at` (where
  `autographFormat` goes in the spec), the row, the card count, the prompt's
  line and the two answers. It is the operator's answer, never drafted and
  never an open decision: `confirmPhrase` does not wait for it. Research it
  (§2.5), and once the operator confirms put `"autographFormat": "On Card"`
  (or `"Sticker/Label"`) at `at` and plan again: the commit stores it on the
  row and every new AU card is born marked. Left out, apply still commits and
  `nb_attention` lists the row until `nb_fix` answers it. A parallel built
  from that insert copies each card's mark, so it does not ask again. A
  parallel built while its insert was unanswered copies "None" and asks on
  its own, and answering the insert later does not reach it: `nb_attention`
  lists it, and `nb_fix` answers it like any row;
- between a draft and its apply the brand can change (another writer syncs
  a sibling set, a marketplace drops a set). A `leave` whose set apply no
  longer shows (now held by another NB row, or no longer listed) is a
  reported no-op in the step's detail: the dialog would create no row for it
  either way. An `own-set` for such a set, a `leave` for a set the spec also
  pairs, and any NEW pending set the spec does not name stay open decisions
  (a new SportLots set outside the set's SportLots filter is left unasked, as
  above).
  The same holds for review answers: an answer for a name the review no
  longer asks about (it is known by now, or was never staged) is a reported
  no-op, for players, teams and leagues alike; a row the review asks about
  with no answer stays open. The draft answers a name on every checklist that
  carries it, so an earlier checklist that stops open cannot strand a later
  one;
  Variant types sync in spec order, and in a collecting apply a later type's
  sync waits on an earlier open one in the same set, because which sets it
  offers depends on what the earlier sync stored; the draft models the same
  order;
- `confirmPhrase`, only when nothing is open. It is not an approval: the
  operator reads the draft and the proposals and gives the phrase.

Then: put the answers into the template, `nb_plan` it, show the operator the
plan and its phrase, and `nb_apply` with that phrase. `nb_apply` collects
(`stopAt: "end"`): the decisions only a write can surface (career teams and
New League steps the lookups stage, a review name the preview could not see)
come back together with one template; answer them and apply again. A set that
does not resolve comes back `unresolved` with near names, plus the brand-year
prepare spec when the brand-year does not resolve or its Sets were never
synced; nothing is created. When the column a name sits in was never synced
(no manufacturers under the year, no Sets under the brand) the message says
so ("Baseball/2014/Topps has not been synced yet. Apply the prepare spec, then
draft this set again.") rather than "No manufacturer named …", which is kept
for a name a synced column does not hold.

**Result size.** `nb_draft_set` returns a summary by default (`detail:
"summary"`, one line of JSON): the template or spec and every open decision in
full; proposals cut to the first five of each kind, steps to the ones not done
yet (up to 40), notes to 20, `leftUnasked` samples to five, with complete
counts in `summary`. `detail: "full"` returns every entry (it drafts again).
The CLI matches: `draft-set` / `build-set` print the summary unless `--detail
full`; the `--out` file and the `--report` JSON are always whole.

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
Insert types only, and they go by name: a suggested parallel that shares no
card number with its insert (an autograph insert named after its set) is
only found when apply builds it, and comes back as a `no-shared-numbers`
open decision rather than an empty "done". Keep it its own set with
`group.topLevel` and a row of its own. A name is decided at the first
checklist apply reaches it in; a later checklist does not repeat it.

**The live proof (`setbuild-oneshot` in `e2e.yml`).** After `seed`, in
parallel with the runner pool, required by the `e2e` gate. Fixture: 2024
Topps Chrome Black (`apps/web/playwright/seed/oneshot.spec.json`, the committed spec;
`oneshot.expect.json`, its expectations). `setbuild oneshot-smoke` drafts it,
requires **no** open decision (the draft settles the whole fixture itself),
merges the draft with the committed spec (any `<…>` from the committed file,
everything else from the draft; `credentials` from the committed file), and
checks the merge four ways:
- with every `leave` taken out of every `sync.pending`, and every checklist's
  review answers taken out, the merge must have the committed spec's digest
  (drift anywhere else fails, naming the paths);
- every drafted review answer must be in the committed spec, at the same
  checklist, with the same value. The committed spec may hold more: an answer
  for a name the draft no longer shows (another writer created it; a moot
  no-op at apply) or for a lookup-staged career team or league the draft
  cannot preview. A drafted answer missing or different fails, naming it;
- per variant type, the drafted `leave`s must be a subset of the committed
  ones. The 2024 Topps flagship › Insert's sole writer
  (`reconcile-sportlots-twins-save-each-to-its-own-set`) runs beside this job
  and takes SportLots sets out of Chrome Black's Pending (they become held in
  the brand); a committed `leave` the draft no longer shows is a moot no-op at
  apply. A drafted `leave` the committed spec lacks is a NEW pending set:
  drift, and the check names the type and ids.
- the draft's `autographFormats` must list exactly the expect file's
  `draft.autographFormats` (Chrome Black's two checklists whose cards carry
  AU: Super Futures Autographs and Ivory Autographs), so an empty list never
  passes, and each must be answered, in the committed spec (the draft never
  drafts one; the merge takes it from the committed file) or in the expect
  file's `fix.autographs`. Chrome Black's autographs are On Card (Jason,
  2026-10-18). Super Futures Autographs is answered in the spec, and its
  parallels, built from it, copy each card's mark. A read-back after apply
  checks it holds `autographFormat` "On Card" and every AU card is marked.
  Pitch Black Pairings Dual Autographs carries no AU attribute in today's
  marketplace data (BSC puts "AU" only in the listing's product name, which
  is never read as an attribute), so nothing asks about it and the spec gives
  it no format.
  Ivory Autographs is answered through `nb_fix` instead, so the live write is
  proven too: it and its two parallels (built while it was unanswered, so
  they ask on their own) are the 3 `autographRows` the first listing shows;
  `nb_fix` answers all three, the second listing shows none, and the same
  read-back checks each.
The job summary shows all three: the leave counts drafted vs committed per
type with the moot count, and the review answers drafted vs committed with
the committed-only count. Then it runs `nb_plan`,
`nb_apply` (`stopAt: "end"`, no stop, the expected `reconciled`, `grouped`,
`committed`, `built` counts) and `nb_inspect` (an insert holding a built
parallel; every row of `builtFromBaseType` holding cards; any `after`
expectations). It signs in as its own worker (`ONESHOT_WORKER`), not one a
runner drains the queue with. Its output never names the deployment.

Measuring the fixture (once the server previews are on the PR preview):

1. `npm run setbuild -- draft-set --path "Baseball/2024/Topps/Topps Chrome Black"
   --out oneshot.draft.json --report oneshot.report.json --auth testing
   --app-url <preview> --convex-url https://<slug>.convex.cloud --worker 8`.
2. The only open decisions may be the operator's own: card conflicts and
   review names with NB candidates (anything else means the draft did not
   settle the set, and the proof fails). Answer each `<…>` in
   `oneshot.draft.json`, add answers for the lookup-staged rows the draft
   cannot preview (career teams and New League steps, read off a collecting
   apply: teams a bare `create` as the baseline answers them, a league
   `create` with its `level`, never a `skip`), put them on every checklist
   whose player stages them, add the `credentials` block the baseline spec
   uses, and commit it as `playwright/seed/oneshot.spec.json`.
3. `plan` it against the same preview; then `apply --collect` on a throwaway
   preview run to read the counts, and commit `oneshot.expect.json`:
   `{ "measured": true, "path", "apply": { "counts": { "reconciled",
   "grouped", "committed", "built" } }, "builtFromBaseType": "Parallel",
   "after": [ … ] }` (optionally `"draft": { "teamLookupBudget": n }`).
   `committed` and `built` are the totals of ONE pass on a fresh preview:
   the sum of every checklist's `expectCards`, and of every build (each
   parallel built from Base, each insert parallel built from its insert).
4. A red merge later is drift: the failing line names the paths that differ
   (or, for the leave lists, the new pending sets). Re-measure in the same PR
   as the evidence. Measure on a preview where the flagship's twins flow has
   NOT yet run, so the committed leave lists are the largest the draft can
   show (a leave the flow later takes out of Pending is moot; one it never
   took is still there). If you measure after it ran, a later run where the
   flow has not run yet will show those sets as new.

Until both files are measured they are placeholders (`"measured": false`) and
the job fails with "fixture not measured yet". A rerun of the oneshot job alone
(without the seed's reset) drafts an already-built set and will not match;
rerun the whole workflow.

The expect file's `attention` block is measured on its own. While it reads
`{ "measured": false }` the job builds and inspects as above, then lists the
set with `nb_attention` (after waiting, up to 10 minutes, for the BSC team
lookup to finish), FAILS with "attention fixture not measured yet", and prints
what it measured: the totals and every item's address. Fill it in from that
line:

```json
"attention": {
  "measured": true,
  "totals": { "cards": 3, "byKind": { "missingTeam": 3 }, "namesToCheck": 1 },
  "fix": {
    "cards": [{ "cardNumber": "<n>", "answer": { "noTeam": true } }],
    "names": [{ "side": "sportlots", "action": "decline", "label": "<as listed>" }]
  }
}
```

The smoke then requires those totals, sends the `fix` answers through
`nb_fix` (taking the phrase from the tool's own refusal, as an agent does),
requires every answer to come back `applied`, and requires a second listing to
show exactly those items gone. Pick answers that need no judgement (a
`noTeam` on a card that truly shows none, a `decline` that keeps NB's name, a
title rewrite of the generated title): the set is rebuilt from a reset each
run, so the answers are the same every time. `lookupWaitMs` (default 600000)
bounds the wait.

### 2.5 What still needs a person (`nb_attention`, `nb_fix`)

A build is not done while the set still shows "N need you" or "N names to
check" in the Set Builder. Every `nb_apply` result ends with
`attentionLine` ("Built and all clear.", or "Built, but not done: … Run
nb_attention to walk them.") and each `setLinks` entry carries `attention`
(the totals and one line). `nb_inspect` with `attention: true` (CLI
`inspect --attention`) adds the same; it reads every card of every row, so it
is opt-in.

`nb_attention` (CLI `attention <path>`) lists, for a set:

- `cards`: every card the checklist header's amber pill counts, in the
  walker's order (missing team, then a name not linked, then titles), each with
  its row, number, name, `cardId`, Set Builder link, reasons (the Set
  Builder's own words), the answers it takes, and the facts its fixer shows:
  the players, the team the listing names and the NB teams that name could
  mean, career teams, `suggested` (exactly what the Set Builder would
  preselect; never written unasked), the title with its meter band and the
  generated title. `detail: "summary"` (default) reads those facts for the
  first 25 cards; `"full"` for all;
- `names`: every "name to check" on the set's own row and every row under it
  (what BSC or SportLots calls the row, when it differs from NB's name);
- `autographs` (NEO-345): every row (Base, insert or parallel) whose
  checklist header asks "on card or sticker?": no autograph format on the row,
  and at least one card carrying "AU" still marked not autographed. Each has
  its row, Set Builder link, the card count, the prompt's own line ("17
  autographed cards — on card or sticker?") and the two answers, `"On Card"`
  and `"Sticker/Label"`. The rule is the Set Builder's own
  (`components/SetSelector/autograph-prompt.ts`), so the list is exactly what
  the header shows. `totals.autographRows` counts them;
- `slReview`: the brand's "SportLots sets to sort" count, named for the
  brand-year ("2 SportLots sets to sort for Topps 2024": the review belongs to
  the brand, not the set; answered with `nb_sl_review_apply` on the
  brand-year, whose `nb_attention` lists the lines);
- `review`: an entity review this server's `nb_apply` left open (answered with
  `nb_decide`);
- `notices`: sync notices the set's columns still show (read-only);
- `totals.awaitingTeamLookup`: cards whose BSC team lookup has not finished.
  More cards may join the list as it drains; list again later.

`nb_fix` (CLI `fix --path <path> --answers <file.json>`) answers them through
the exact saves the fixers and the names dialog make, under one confirm phrase
over the exact answers:

```json
{
  "cards": [
    { "cardNumber": "12", "answer": { "teams": ["San Diego Padres"] } },
    { "row": { "type": "Inserts", "name": "Future Stars" }, "cardNumber": "FS-3", "answer": { "noTeam": true } },
    { "cardNumber": "103b", "answer": { "title": "<the title text>", "variation": "<shorter variation>" } },
    { "cardNumber": "44", "answer": { "players": [{ "link": "Jose Rodriguez", "birthYear": 2001 }], "teams": [{ "create": { "location": "Wisconsin", "name": "Badgers" } }] } }
  ],
  "names": [
    { "row": { "type": "Inserts", "name": "Future Stars" }, "side": "bsc", "action": "accept", "label": "Future Stars Inserts" },
    { "side": "sportlots", "action": "decline", "label": "Chrome" }
  ],
  "autographs": [
    { "row": { "type": "Insert", "name": "Ivory Autographs" }, "format": "On Card" }
  ]
}
```

- An autograph answer names its row (omitted = Base) and the format, and goes
  through the header prompt's own save (`setAutographFormat`). The server then
  marks the row's autographed cards in a scheduled walk; `nb_fix` waits for it
  (once for the whole call, bounded at about 30 s, checked between polling
  passes) and gives a `warning` with the count for a row it
  did not see finish. A row that already has a format, or whose autographed
  cards are all marked, is `moot`: change a format in Set details. At most 50
  per call. An insert's or the Base's answer also lands on each of its
  parallels with no format of its own (one holding a format keeps it), and
  the wait covers their cards too; the result's `parallels` counts them. The
  answers are written deepest row first, so a parallel answered in the same
  call keeps its own answer. A card the format reaches has its listing title
  rebuilt (it gains "AUTO") only while the title is still exactly the
  generated one; a title someone wrote or edited is left alone.
- **Research, then ask.** The tool never guesses an answer. An agent driving
  it looks up what a source can settle (an autograph row's format, a card's
  missing team, a variation that must be shortened) on the manufacturer's
  checklist or product page, Beckett, Cardboard Connection and the like,
  brings the operator a proposal with the source, and sends it only once the
  operator confirms. With no source, it says so and asks.

- A card is named by its row (omitted = Base) and number; add `cardId` when
  the number is on two cards in the row (the listing prints it). A name that
  is not exactly one row, team or player stops the whole call before anything
  is written, with the candidates.
- A title over 80 characters is refused; a variation over 65 is saved with a
  warning, as the Set Builder allows. A name answer must repeat the label the
  listing showed; a label that changed since is refused, never accepted unseen.
- An answer whose item is already gone is reported `moot`; one the save
  refuses is `refused` with the reason. `remaining` and `summary` say what is
  still left. CLI `fix` exits 3 when an answer was refused.
- A `create` only ever creates. A team or player already on file under that
  name (one era, several, an alias; one same-name player, or one born in the
  given year) is refused with the candidates; link it with the team's name or
  `{ "link", "birthYear" }` instead.
- At most 100 card answers, 200 name answers and 50 autograph answers per
  call; split a bigger batch and confirm each part.
- A failure part-way (network, auth, a server fault) still returns every
  answer it settled, and any name save sent but not read back as
  `unconfirmed`; CLI `fix` prints them before the error. List attention again
  before answering the rest.
- `--auth machine` takes the phrase at a prompt only, as `apply` does.

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
3. Add the answer to `playwright/seed/baseline.spec.json` (or `parallel.spec.json`),
   naming the row by its marketplace id where the template offers one.
4. Validate it against the same preview without waiting for CI:
   ```bash
   npm run setbuild -- plan --spec playwright/seed/baseline.spec.json \
     --auth testing --app-url <preview URL> --convex-url https://<slug>.convex.cloud
   ```
   (With the two secrets exported, see §2.2 for where CI gets them.) `plan` is
   read-only. Once clean, push; CI runs the whole thing.
5. If the stop is in the wizard (a new player, team or league the spec has not
   named), the template lists the row and the New Team / New League fields the
   UI would ask for. Add each, exactly as the UI would have created it. A
   league answered `"create"` needs a `level` (`major`, `minor`, `college`,
   `international`, `independent` or `other`), the button the operator would
   press on the New League step; the template leaves it as a fill-in because
   nothing on the row says where the league sits. The baseline's own league
   answers use `"other"`, the level the retired seed flow pressed.
   A player that shares its name with catalogue players (the pick step,
   `Which <name> is this?`) is linked by name and birth year,
   `{"link": "Jose Rodriguez", "birthYear": 2001}`: read the card's year,
   team and RC flag against each candidate's birth year and stints, and
   answer `"create"` only when none of them is the man on the card. A
   `{link, birthYear}` that matches none or several stops with every
   same-name birth year listed.

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
2. **Name the team or league** in the spec exactly as the template says
   (a league `"create"` with its `level`, see §4 step 5).

`seed` already prints the coverage report (`covered` / `missing`) to the job
summary; a non-empty `missing` after a green seed means the recording is
getting stale, not that the seed is wrong (NEO-289 §3).

## 7. Cleaning up

`setbuild` leaves no state of its own. The CI seed job's token is minted per run
and expires; `apply`'s only side effects are the Convex rows it writes. After a
local seed, the deployment holds the baseline until the next reset.
