# setbuild

NEO-339. Builds sets through the **same public admin Convex functions the Set
Builder UI calls**, as a real admin, from a declarative JSON spec. It adds no
Convex function, HTTP action or secret.

Operators: read `docs/operations/neo339-setbuild.md` (running plan/apply/MCP
locally and in CI, production use, fixing a red seed, marketplace drift,
enrichment capture). This file is for people changing the tool.

## Commands

```bash
cd apps/web
npm run setbuild -- help
npm run setbuild -- whoami|inspect|plan|apply|decisions-template|schema|mcp-smoke ...
npm run setbuild -- draft-set --path "Sport/Year/Manufacturer/Set" --out draft.json   # read-only draft
npm run setbuild -- build-set --path "Sport/Year/Manufacturer/Set"                    # terminal only: draft → approve → apply
npm run --silent setbuild -- confirm-phrase --spec <file.json> --convex-url <url>   # offline
npm run setbuild:mcp          # MCP server over stdio (repo-root .mcp.json: nb-setbuild)
```

Exit codes: 0 ok, 1 the command failed, 2 usage error (including `apply
--auth machine` and `build-set` without a terminal), 3 `apply` stopped at an
open decision, or `draft-set` / `build-set` left one for the operator.

`draft-set` / `nb_draft_set` (`runner/draft.ts`) draft a whole set's spec from
the server's three read-only previews (`previewSetStructure`,
`previewCardChecklist`, `previewChecklistEntities`), through the same
`lib/set-build` modules the UI runs. They return `{ spec, proposals,
openDecisions, template, confirmPhrase, marketplaceCalls }`: proposals are
what the UI settles without asking (and the three Jason ruled pre-filled:
Group Parallels suggestions, `create` for a name with no NB candidate, and an
explicit `leave` per id, with the marketplace's name, for every pending
marketplace set nobody pairs, shown as one `reconcile-leave` proposal per
type; `own-set` is never proposed); everything else is an open decision with
a `<…>` fill-in. A player name only one side of an unanswered card conflict
carries is never pre-filled: its fill-in names the conflict it rides on.
SportLots' insert-level list is brand-year wide, so a SportLots set outside
the Reconcile dialog's own prefix filter (`defaultSlPrefixes` in
`lib/set-build/reconcile.ts`), or one another variant type of the set pairs,
is not listed: it is counted in `leftUnasked`, and apply leaves it in Pending
unasked (`dialogOpenDecisions`' `left`). `nb_draft_set` returns a summary by
default (`compactDraftReport`: the template or spec and every open decision
whole, the other lists sampled with complete counts); `detail: "full"` /
`--detail full` returns everything. `confirmPhrase` is
null while anything is open, and is never an approval. The draft runs on
`draftClient` (`DRAFT_READ_ACTIONS` = `fetchRawOptions` + the two preview
actions; every mutation refused) and is bounded: a per-draft BSC team-lookup
budget, no retries, and a refused marketplace session stops that side's later
previews. Adapter error text never reaches the result. A `leave` whose set
apply no longer shows (held by another row, or no longer listed) is a
reported no-op (`splitMootLeaves`); an `own-set` for it stays open. Review answers work the same way in a spec
run: an answer for a name the review no longer asks about is a reported
no-op (`matchReview`'s `mootUnmatched`; `decide` stays strict), and the draft
answers a name on every checklist that carries it. A later
variant type's sync waits on an earlier open one in the same set (its held
ids depend on what the earlier one stored). The engine's `draft`
mode walks the drafted spec read-only (no action at all) for `steps`.

`apply` stops at the first open decision; `apply --collect` (and `nb_apply`,
whose `stopAt` defaults to `"end"`) runs every step that does not depend on
one and returns them all, with one fill-in template. What waits on what is the
table at the top of `runner/engine.ts`. The confirm phrase does not cover
`stopAt`: it changes how far a run goes, never what the spec allows.

A spec check that fails during apply stops its step the same way. That
covers an expected count (`expectCards`, `expectRows`,
`group.expectUngrouped`), a Match Cards answer naming a card the fetch does
not hold, or a build the server refused: every `StepCheckError`
(`lib/step-check.ts`). The step is recorded `blocked` with the reason, what
depends on it waits, and the run returns its report with every step done so
far. Many of these checks can only run during apply, because the rows they
read do not exist before it. Only an error that is not a spec check (network,
auth, a marketplace fetch, a server fault) ends the run as `RunFailed`. That
error still carries the report so far: the CLI prints it (and writes it to
`--report`), and `nb_apply` returns `isError` with it as `report`.

`plan`, `apply` and `decisions-template` take `--paused-platforms <keys>`
(default: env `PAUSED_PLATFORMS`; an explicit `""` means nothing is paused).
`mcp-smoke` passes it to the server it spawns, and the MCP server reads
`PAUSED_PLATFORMS` from its own environment.

## Connection (shared by the CLI and the MCP server)

| Flag | Env | Purpose |
|---|---|---|
| `--convex-url` | `NB_SETBUILD_CONVEX_URL` | The target. There is no fallback to `VITE_CONVEX_URL`. |
| `--auth machine\|testing` | `NB_SETBUILD_AUTH` | Token source. |
| `--app-url` | `NB_SETBUILD_APP_URL` | `testing`: origin serving `/api/auth/testing`. Both modes: the web app the Set Builder links are printed on (set it under `--auth machine` too, or the links are root-relative `/admin/set-builder?…`). |
| `--worker` | `NB_SETBUILD_WORKER` | `testing`: per-worker test account (default 0). |
| `--publishable-key` | `VITE_CLERK_PUBLISHABLE_KEY` | `testing`: derives the Clerk FAPI origin. |
| `--transport ws\|http` | `NB_SETBUILD_TRANSPORT` | Default `ws` (`ConvexClient`); `http` is the fallback. |
| `--convex-site-url` | `NB_SETBUILD_CONVEX_SITE_URL` (MCP server) | Only for a custom Convex domain. With `--auth machine` it must be the `.convex.site` twin of `--convex-url` (loopback excepted), since the API key is posted there. |
| `--env-file` | `NB_SETBUILD_ENV_FILE` | dotenv file loaded first (does not override the environment). |
| `--json` | | Machine-readable output. |

Secrets come from the environment only: `NB_SETBUILD_API_KEY` (machine),
`TESTING_ENDPOINT_SECRET` and `VERCEL_AUTOMATION_BYPASS_SECRET` (testing). Every
output path (MCP results, report files, CLI errors) goes through one `scrub`
(`auth/token-source.ts`): the secret values plus anything JWT-shaped. Never add
a flag that accepts a secret, and never print or write output that skips
`scrub`.

`--auth testing` refuses a `pk_live_` publishable key, an `http://` app URL off
loopback, and any minted token whose `iss` is not the FAPI host the key names;
the bypass header goes only to an https origin.

## Layout

```
auth/      token sources (machine API key, testing ticket -> Clerk template JWT)
client/    target parsing, connection resolution, ConvexClient wrapper
spec/      the zod spec schema and loader
lib/       one module per operation (credentials, sync, map base, reconcile, group parallels, review, commit, parallel build)
runner/    plan, apply and draft: ordering, idempotency, stopAt (first / collect), open-decision templates
service.ts the seam the CLI and the MCP tools both call (read vs write halves)
mcp*.ts    the MCP server, its eight tools, mcp-smoke and oneshot-smoke
```

## Rules to keep

- **Read and write are separate objects** in `service.ts`. Read tools hold no
  reference to the write half, and `inspect` / `reviewItems` run on
  `queryOnlyClient` (a mutation or action throws before it is sent); `plan`
  runs on `readOnlyClient`, which also allows the marketplace candidate read.
- **The confirm phrase is `BUILD <host> <scope> <digest>`**, the digest being
  8 hex of SHA-256 over canonical JSON (`client/target.ts`) of the parsed spec
  or the write's arguments. One helper per write in `service.ts`
  (`specConfirmPhrase`, `decideConfirmPhrase`, …) is used by both the MCP tool
  and the service, so the two cannot drift. Never compose a phrase elsewhere.
- **Writes check the phrase twice**: in the MCP tool and in the service. On
  the CLI, `--auth testing` takes `--confirm` (or a TTY prompt); `--auth
  machine` ignores `--confirm` and requires the TTY prompt.
- **A `specPath` must resolve inside the repo or `INIT_CWD`**
  (`containedSpecPath`).
- **No wildcards, no inference.** A decision is either in the spec or an open
  decision. Ties are never given to the first candidate.
- **Review answers mirror the wizard's steps.** A player, team or league is
  `"create"`, `"skip"` or `{ "link": "<existing NB name>" }`. A player link
  may add `birthYear` (`{ "link": "Jose Rodriguez", "birthYear": 2001 }`)
  when several NB players share the name: it links the one same-name player
  born that year, and stops with a `ResolveError` listing every same-name
  player's birth year when none or several match. Without `birthYear`, a link
  by a shared name stops the same way. A draft (and an apply template) offers
  that form for a same-name player and lists each candidate's birth year. A
  team may add
  `location` and `league` (the New Team step's fields; `location` is the
  place or sponsor the name begins with, e.g. `"Hanwha"` for "Hanwha Eagles"). A league `"create"`
  must carry `level`, one of the schema's `leagues.level` values (`major`,
  `minor`, `college`, `international`, `independent`, `other`): NEO-331 made
  the level required and the New League step pre-picks none, so the spec says
  it (`LeagueDecisionSchema`; a `level` on a link or skip is refused). The
  template leaves an unanswered league's `level` as a `<…>` fill-in, and a
  team's `league` only ever LINKS a league (an existing one, or a New League
  step the batch answers first), never creates one by name.
- **A card conflict is answered with a side, or unlinked.** A name or players
  disagreement on a pair the server matched (on the number) is answered in
  `pairing.conflicts` with `choose: "bsc" | "sportlots"`. When the pair is two
  different cards that share a number (a checklist can list #482 twice),
  `pairing.unlink: [{ "bsc": "<ref>", "sportlots": "<ref>" }]` is the Match
  Cards dialog's Unlink: applied first, through the dialog's reducer, it puts
  both cards back in their unmatched columns, each with its own name, roster
  and marketplace ref, where `unmatchedBsc` / `unmatchedSportlots` decide them,
  and the pair's conflicts are no longer asked. An unlink names one matched
  pair. If both cards are in the fetch but are not paired to each other, the
  entry is already met: the step reports it "already apart". If either card is
  not in the fetch, or several pairs fit, the step stops. A `conflicts` answer
  for an unlinked pair is refused at parse. The open decision and the fill-in
  both name the unlink option.
- **Idempotent and resumable.** Every step checks state before it writes.
  That includes rows the `group` step moved: a sync pair (or `own-set`) whose
  ids a grouped row carries EXACTLY is already saved (`groupedClaims` in
  `lib/reconcile-variants.ts`), so re-running a spec after Group Parallels
  asks nothing new. Partial overlap stays an open decision, and a grouped row
  tied with another row on the same ids is asked, never given to either.
- **No marketplace name is ever a key.** Rows are addressed by NB path or by a
  marketplace id from a slot (a `group` ref may be `{ "bsc": id }` or
  `{ "sportlots": id }`, matched against the rows' platform slots).
- **Group Parallels runs the dialog's own code.** `lib/group-parallels.ts`
  drives `lib/set-build/grouping.ts` (the reducer, tree builder and diff the
  modal imports) and `chunkGroupingPlan`; never re-implement a rule there. It
  takes no prefix suggestion: a row the spec does not name stays put.
  `group.topLevel` is the dialog's ✕: a grouped row it names moves back out to
  stand as its own set (a row named there and as a parallel is an open
  decision).
- **A parallel build that shares no card number with its source is not
  done.** When a build copies 0 cards while the parallel's own listing returned
  cards (the server's `extraOnMarketplace`), apply records a
  `no-shared-numbers` open decision (in `openDecisions.grouping`) instead: the
  row is probably its own insert that Group Parallels grouped by name. Like
  every open decision it stops `stopAt: "first"` and is collected by `"end"`;
  nothing waits on it. The answer is `group.topLevel` plus a row of its own. A
  partial build (some cards copied) is an ordinary build, as is one whose
  listing returned nothing; a spec that expects 0 cards for the row has
  already accepted it empty.

## Tests and gates

```bash
npm run typecheck                           # includes tools/setbuild/tsconfig.json
npx vitest run tools/setbuild               # unit + the MCP in-memory suites
```

`mcp-tools.test.ts` drives a real `McpServer` and `Client` over
`InMemoryTransport` with a fake service; `mcp-allowlist.test.ts` asserts no MCP
write tool appears in `.claude/settings.json` and that every `.mcp.json` env
value is a `${VAR}` reference.

## CI

`e2e.yml` `seed` and `seed-mobile` jobs (one per pass): compute both phrases with `confirm-phrase`, reset,
`apply --spec playwright/seed/baseline.spec.json`, `mcp-smoke --spec
playwright/seed/parallel.spec.json --expect playwright/seed/mcp-smoke.expect.json`
(its `--confirm` must equal `nb_plan`'s phrase). `e2e-seed.sh` computes its
phrase the same way (it applies `parallel.spec.json` instead of the MCP
smoke). The reports upload as the `setbuild-seed` / `setbuild-seed-mobile`
artifacts.

`e2e.yml` `setbuild-oneshot` job (after `seed`, beside the desktop shards, once
per run, required by the gate; `seed-mobile` waits for it): `oneshot-smoke --answers playwright/seed/oneshot.spec.json
--expect playwright/seed/oneshot.expect.json` drafts 2024 Topps Chrome Black,
checks the draft merged with the committed answers has the committed spec's
digest (`mergeDraftAnswers`), then plans, applies (`stopAt: "end"`) and
inspects. The draft's only open decisions may be card conflicts and review
names, answered by the committed spec; its leaves and review answers must be
subsets of the committed spec's, and everything else must match exactly. Placeholder fixture files (`"measured": false`) fail it on purpose.
Neither job prints the deployment: the host is masked and redacted.
