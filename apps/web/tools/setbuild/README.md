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
npm run setbuild -- attention "Sport/Year/Manufacturer[/Set]" [--detail full]       # read-only: what still needs a person
npm run setbuild -- fix --path "Sport/Year/Manufacturer/Set" --answers answers.json  # writes: answer it
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
unasked (`dialogOpenDecisions`' `left`). The matcher pairs BSC and SportLots
sets by name, and SportLots names no product for a set, so a name-only pair
(an auto-match no NB row already holds) is drafted only when the cards
confirm it (`lib/pair-evidence.ts`): the pair's own preview must share at
least one card number, and at most a third of the shared numbers may name
different players (`MAX_DIFFERING_SHARE`). Otherwise, or with no preview to
compare (checklists off, a failed preview), or while the brand's SportLots
review still holds the SportLots set (`readUnsortedSlIds`), the row is
drafted from its other ids and the SportLots set is an open decision
(`reconcile-unsorted-sportlots`, answered at `sync.pending`, its detail citing
the evidence: "2 of 3 shared card numbers name different players"). An
insert row's evidence is its own checklist preview, read once; each other
pair costs one preview (a Parallel type's with no team lookup). Apply sees no
cards before it saves: it pairs only what the spec names, never offers an
auto-match whose SportLots set the review holds, and its template leaves a
proposed pair's SportLots half as a fill-in.
Group Parallels' suggestions (`detectGroupings`) are the plain prefix rule,
as in the modal. The draft weighs one case by card numbers: a suggested
child that roots a family of its own ("Future Stars Autographs", which
"Future Stars Autographs Red" extends, under "Future Stars"). It previews
both rows, and only when their cards share no number does the row stay top
level as the parent of its own family (`holdFamilyRoots`). A shared number,
or no preview to compare, groups it and its family under the parent.
`nb_draft_set` returns a summary by
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

Every plan and apply report starts with `setLinks`: one `{ path, link }` for
each set the run resolved to an NB row (built, touched, blocked or skipped),
in spec order. A set that never resolved has no entry. `inspect` gives a
`link` for the node it shows and for every variant type, row and parallel it
lists. A link is the Set Builder's own drill URL, built from the NB ids the
walk already holds, so it costs no query. It is absolute on `--app-url` /
`NB_SETBUILD_APP_URL` when that is set, and root-relative
(`/admin/set-builder?sport=…&set=…`) otherwise. A root-relative link opens
nothing on its own, so every report that carries links (plan, apply, inspect,
attention) then adds `linksNote`: "Links are paths only: set
NB_SETBUILD_APP_URL to the app address for this deployment." The CLI prints
the set links under the report's target line, and `inspect` prints the
node's link under its path.

**The app URL goes with the Convex URL.** `NB_SETBUILD_APP_URL` is the origin
of the web app that serves the deployment `NB_SETBUILD_CONVEX_URL` points at:
the production app for the production deployment, a PR's preview app for
that PR's Convex preview, a local Vite (`http://localhost:<port>`) for the
deployment that Vite's `VITE_CONVEX_URL` names. Set them as a pair, per
environment (`.mcp.json` passes both through from the environment):

```bash
NB_SETBUILD_CONVEX_URL=https://<deployment>.convex.cloud
NB_SETBUILD_APP_URL=https://<the app that serves that deployment>
```

The tool never guesses the pair: a link on another deployment's app would
open its Set Builder, where these ids mean nothing.

**A build is not done while the set still needs a person.** Every apply
ends by reading, per set in `setLinks`, what the Set Builder would still
show (`runner/attention.ts`, queries only): the cards the checklist header's
"N need you" pill counts (`lib/attention.ts`, over `deriveCardAttention`),
the "N names to check" suggestions on the set and every row under it
(`lib/name-suggestions.ts`), the rows whose checklist header asks "on card or
sticker?" (below), and the brand's SportLots sets to sort, named for the
brand-year ("2 SportLots sets to sort for Topps 2024": the review is the
brand's, not the set's). Each link gains `attention` (totals and one line)
and the report gains `attentionLine`: "Built and all clear." only when
nothing on any set is waiting, lookups and autograph rows included. A failed read is said in the line, never a lost
report. `nb_attention` / `attention` lists every item with the facts its
fixer shows and the answers it takes; `nb_fix` / `fix` answers them through
the fixers' own mutations (`lib/attention-answers.ts`: `updateCard`,
`confirmCardNoPlayer`, `confirmCardNoTeam`, the pickers' `findOrCreate`) and the names dialog's
(`applySelectorSyncSuggestions`, `baseVersion` read at fix time, the label
checked against a fresh read, 200 decisions per call). The answer shapes are
one zod schema (`lib/fix-answers.ts`) shared by the tool and the CLI's
`--answers` file, so both compute the same phrase. Sync notices are listed
read-only; the SportLots review and an open entity review point at
`nb_sl_review_apply` and `nb_decide`. `nb_inspect` takes `attention: true`
(CLI `--attention`) for the totals alone.

**A card with no player (NEO-339).** Jason, 2026-10-19: a card that links to
no player "needs you", by exactly the Set Builder's rule. `missingPlayer`
fires when the card has no `playerIds`, no typed player name (that is
`unreviewedName`) and no operator "No player on this card"
(`playerNoneConfirmedAt`); it is walked first, ahead of missing teams,
because a linked player is what the team question's suggestions come from.
`nb_attention` lists it with the card's name and number and `teamsOnCard`
(the clue that a card with nobody on it is the team card). It takes
`{ players: [...] }` (each a name that is exactly one player in the sport,
`{ link, birthYear }`, or `{ create }`, which only ever creates, as every
player answer; plus `teams` when the card is missing its team too, in the
same write) or `{ noPlayer: true }` for a checklist, team, logo or relic card
that shows nobody (`cardChecklist.confirmCardNoPlayer`, refused once the card
names a player). Linking a player later retires the stamp.

**Autograph format (NEO-345).** A card carrying "AU" is signed; HOW it is
signed (On Card or Sticker/Label) is NB data no marketplace gives, so the
operator says it once per row (Base, insert or parallel), stored on the row as
`features.autographFormat`, and the row's AU cards take it as
`features.autographed`. Three places carry the answer:

- **The spec.** A checklist's optional `autographFormat` (`"On Card"` or
  `"Sticker/Label"`) is the wizard's "Autographed cards" answer, sent as
  `commitCardChecklist`'s own `autographFormat`: the row stores it and every
  new AU card is born marked. `nb_draft_set` never proposes it. It lists each
  checklist whose previewed cards carry AU in `autographFormats` (`at`, the
  row, the card count, the prompt's line, the two answers), not as an open
  decision: `confirmPhrase` does not wait for it, and the default is "save and
  list" (Jason, 2026-10-18): a spec without it still commits, and the rows are
  listed afterwards. `mergeDraftAnswers` takes a checklist's `autographFormat`
  from the answers file, like `pairing.unlink`. A parallel built from an
  insert copies each card's `autographed` with it, so a parallel built after
  a formatted commit does not ask again. A parallel built while the insert
  was still unanswered copies "None" and asks on its own; answering the
  insert later does not reach it (the server's walk covers the row's own
  cards only), so `nb_attention` lists it and `nb_fix` answers it too.
- **`nb_attention`'s `autographs`.** One item per row whose header asks:
  no `features.autographFormat` on the row and at least one AU card still
  marked "None". The rule, the count, the line ("17 autographed cards — on
  card or sticker?") and the answers' names come from
  `components/SetSelector/autograph-prompt.ts`, the same pure module
  `CardChecklist` gates the prompt on, so the tool lists exactly what the Set
  Builder shows (`autograph-prompt.test.tsx` pins the parity). Totals carry
  `autographRows`; the summary says "N autograph rows to mark on-card or
  sticker".
- **`nb_fix`'s `autographs: [{ row, format }]`** (set path only, at most 50
  per call, in the confirm digest only when given, so a cards-and-names
  phrase is unchanged). Each goes through the prompt's own
  `autographFormat.setAutographFormat`. A row that already has a format, or
  whose AU cards are all marked, is moot (changing a format is Set details'
  job). The carry-over to the cards is a scheduled server walk, so `nb_fix`
  then waits, once for the whole call, until each row's own AU cards stop
  showing "None". The wait is bounded at about 30 s (`AUTOGRAPH_WAIT_MS`,
  checked between polling passes, so a slow pass can run a little past it),
  and gives a
  `warning` with the count for a row it did not see finish.

Setting the format after the commit does not rebuild the cards' listing
titles: the walk writes `features.autographed` (and Signed By) only, so a
title generated without "AUTO" keeps it until Regenerate (whose preview reads
the new value). A commit that carries the format titles its AU cards with it.

**Detaching a wrong marketplace link (`nb_fix`'s `detach: [{ row, side, id }]`,
`lib/detach-answers.ts`).** The Set Builder's Sources panel × as an answer:
set path only, at most 10 per call (`MAX_FIX_DETACH`), in the confirm digest
only when given (every earlier phrase holds). The row is named like every fix
answer (omit for Base); the id resolves to its slot by id (`slotForId`),
never by label, and an id the row does not carry is moot. The card count is
read at fix time (`getSlotCardCounts`) and sent as `acknowledgedCards` to
`selectorOptions.detachPlatformId`, so a commit landing in between is refused
(`DETACH_COUNT_CHANGED`, reported, nothing written); the reconciler's primary
goes with `confirmPrimary`, as the panel's confirm sends it, and a later sync
of the row could re-add it. Like the panel, it removes no card: the cards
fetched from that set stay on the row (counted in the result as
`orphanedCards`), for the operator to delete in the Set Builder. `nb_fix` is
annotated destructive for it.

**Research before asking (Jason, 2026-10-18).** The tool never guesses a
fact about the real card and never writes one unasked. The agent driving it
should look up what a source can settle before putting the question to the
operator: an autograph row's format, who is on a card with no player (or
that it shows nobody), a card's missing team, a variation that must be
shortened. It checks the manufacturer's checklist or product page,
Beckett, Cardboard Connection and the like, brings the operator a proposal
with the source it used, and writes it (spec or `nb_fix`) only once the
operator confirms. With no source it says so and asks. A team it found is
shown beside `listingSays`; when they differ, the operator decides. The
WORKFLOW string every read tool carries, and `nb_fix`'s description, say this.

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
mcp*.ts    the MCP server, its ten tools, mcp-smoke and oneshot-smoke
```

## Rules to keep

- **Read and write are separate objects** in `service.ts`. Read tools hold no
  reference to the write half, and `inspect` / `reviewItems` / `attention` run on
  `queryOnlyClient` (a mutation or action throws before it is sent); `plan`
  runs on `readOnlyClient`, which also allows the marketplace candidate read.
- **The confirm phrase is `BUILD <host> <scope> <digest>`**, the digest being
  8 hex of SHA-256 over canonical JSON (`client/target.ts`) of the parsed spec
  or the write's arguments. One helper per write in `service.ts`
  (`specConfirmPhrase`, `decideConfirmPhrase`, `fixConfirmPhrase`, …) is used by both the MCP tool
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
- **A row resolves by its own name, grouped or not.** `resolveVariantRow`
  answers from the type's top-level rows first; only when none carries the
  name does it read the rows Group Parallels moved under an insert, so a
  grouped row is never mistaken for the parent its name begins with. A name
  that matches nothing says so, and lists near names as candidates only.
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
inspects, then (the expect file's `attention` block) lists what the built set
still needs, answers it with the committed `fix` answers through `nb_fix`, and
checks exactly those items are gone. The draft's only open decisions may be card conflicts and review
names, answered by the committed spec; its leaves and review answers must be
subsets of the committed spec's, and everything else must match exactly.
The autograph path is proven both ways (2024 Topps Chrome Black's
autographs are On Card, Jason 2026-10-18). The draft must list exactly the
expect file's `draft.autographFormats` (the three checklists whose cards
carry AU), and each must be answered by the committed spec or by the expect
file's `fix.autographs`. Super Futures Autographs and Pitch Black Pairings
Dual Autographs are answered in the spec (PBDA's AU comes from BSC's per-card
`productName`, which the fetch reads), and a read-back after apply checks each
holds `autographFormat` "On Card" with every AU card marked; their built
parallels take the format at build time and do not ask. Ivory Autographs
is left out of the spec on purpose: it and its two built parallels are the
`autographRows` (3) the first listing must show, `nb_fix` answers Ivory alone
live through `setAutographFormat`, the answer reaches both parallels, the
second listing must show none (`afterAutographRows: 0`), and the same
read-back checks all three rows. Placeholder fixture files (`"measured": false`) fail it on purpose.
Neither job prints the deployment: the host is masked and redacted.
