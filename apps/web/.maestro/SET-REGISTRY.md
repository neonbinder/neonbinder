# E2E Set Registry

Every set the Maestro suite touches is listed here. Two rules govern this file:

1. **Adding a new REAL (marketplace-backed) set requires explicit owner approval,
   every time.** A real set costs a 30–90s BSC/SL sync on first use. The
   marketplaces carry essentially every set ever printed, so the constraint is
   cost and determinism, not availability. Ask before adding one — do not add a
   real set because it seemed convenient.
2. **Every custom set prefix must be registered below before use.** The registry
   exists so two flows never silently collide on the same name.

## Real marketplace-backed sets

These are provisioned once by `flows/setup.yaml` at the head of every run and are
**READ-ONLY for all other flows**.

| Set | Variant types provisioned | Provisioned by |
|---|---|---|
| Baseball → 2024 → Topps → Topps Chrome | `Base` (full checklist), `Insert` → "Future Stars" (~20 cards), `Parallel` → "Gold Wave Refractors" (~300 cards) | `flows/setup.yaml` |
| Baseball → 2024 → Topps → Topps Big League | `Base` — variant types synced and Base MAPPED, checklist deliberately EMPTY (NEO-248 wizard fixture) | `flows/setup.yaml` |
| Baseball → 2024 → Topps → Topps 206 | none — variant types sync on first use; Base stays **UNMAPPED** (NOT pre-synced) | `flows/set-selector/base-mapping-cancel-recovers.yaml` — **sole writer**, and it writes nothing |
| Baseball → 2024 → Topps → Topps Chicago Cubs | `Base` — variant types synced, Base MAPPED on BOTH sides, checklist deliberately EMPTY | `flows/setup.yaml` (structure); **sole writer** `checklist-wizard-skip-commits-and-unskip.yaml` |
| Baseball → 2024 → Topps → Topps Baltimore Orioles | `Base` — same shape | `flows/setup.yaml` (structure); **sole writer** `checklist-wizard-career-team-commits.yaml` |
| Baseball → 2024 → Topps → Topps Brooklyn Collection | `Base` — same shape | `flows/setup.yaml` (structure); **sole writer** `checklist-wizard-link-commits.yaml` |
| Baseball → 2024 → Topps → Topps Heritage | `Base` — SportLots base mapping CONFIRMED in-flow (NOT pre-synced) | `flows/set-selector/sets-base.yaml` — **sole writer** of that mapping. ✅ **RATIFIED 2026-09-09** (NEO-260) — it was already in use and had never been listed |
| Baseball → 1996 → Score → Score | `Insert` (reconciled in-flow, NOT pre-synced) | `flows/set-selector/inserts-1996-score-one-nb-set-two-bsc-sources.yaml` — **sole writer** |
| Hockey → 2024 → Topps → Topps NHL Sticker Collection | none — the flow never goes below `Variant Types` (NOT pre-synced) | `flows/set-selector/set-rename-survives-resync-and-suggests-bsc-name.yaml` — **sole writer** |
| Hockey → 1995 → All Brands → Roanoke Express ECHL | `Base` — 25 cards, fetched and COMMITTED in-flow, BSC only (NOT pre-synced) | `flows/set-selector/checklist-one-marketplace-skips-match-dialog.yaml` — **sole writer**. ✅ **APPROVED 2026-09-09** (NEO-260) |

### 2024 Topps NHL Sticker Collection — NEO-211, sole-writer ⚠️ SUBSTITUTED, NEEDS SIGN-OFF

The owner approved **Hockey → 1972-73 → Topps → "Topps"** on 2026-09-03
(NEO-211 plan of record, decision 5). **That set does not exist in NeonBinder's
synced taxonomy.** Verified live against dev the same day:

* the Years column for Hockey holds PLAIN four-digit years — filtering `1972`
  returns exactly one row, `1972`, and there is no `1972-73`;
* **Hockey → 1972 → Topps returns ZERO sets.** The column settles (its
  `Syncing Sets` panel comes and goes) showing only `Sync Sets` and `+ Custom`;
* **Hockey → 2024 → Topps returns three** — `Topps NHL Sticker Collection`,
  `Topps Now NHL Stickers`, `Topps Now The Gr8 Chase` — and the first carries a
  BSC link plus the variant types `Base` and `Parallel`.

So the SHAPE the plan asked for is available on the same sport and manufacturer,
one year apart, and the flow is written against it. Because rule 1 above requires
owner approval for **every** real set, this substitution is flagged rather than
assumed: confirm it, or name a different set and change the four `env:` values
in the flow's STEP 1 plus the four name literals below it.

It exists to prove one thing that no custom set can express: **a NeonBinder
rename survives a forced marketplace re-sync, and the marketplace's own name
comes back as a suggestion rather than as an overwrite.**

A hand-made Set node carries no marketplace ids, and neither does anything
created under it. A marketplace side is fetched only when the ids that side
needs are present on the ancestors (NEO-239) — so for a hand-made set neither
side is resolvable, neither is fetched, and there is no id to match on, no
marketplace label to disagree with our name, and no forced sync worth forcing.
The feature only exists where a real marketplace holds an opinion about what the
row is called.

`setName` is a **BSC-only level** — the SportLots adapter returns
`success: true, options: []` for it by design — so a renamed set can only ever
disagree with one marketplace, and the flow's `1 suggestion` assertion is exact
rather than data-dependent.

**What the flow does, and what it leaves behind** (this IS the contract):

| | |
| -- | -- |
| drills | Hockey → 2024 → Topps → `Topps NHL Sticker Collection`, all four levels COLD (see `util-drill-to-cold-real-set.yaml`) |
| writes | renames the set row to `TCG`, forces `Sync Sets`, then ACCEPTS BSC's suggestion |
| leaves | the set named **`Topps NHL Sticker Collection`** again — accepting restores the baseline, so the flow is idempotent |
| never touches | cards, players, teams, or anything below `Variant Types` |

The flow tolerates a run that died between the rename and the accept (the row
left as `TCG`) by selecting on the regex `Topps NHL Sticker Collection|TCG` and
skipping the rename when the row already reads `TCG`. CI never needs that:
`setup.yaml` resets the set-builder tables at the head of every run, so the set
is always re-synced from BSC under its own name.

**Sole writer.** Exactly ONE flow may ever touch this set. A second would race
it on `selectorOptions`, which is global and unscoped, and the whole point of
the fixture is a rename that is observable for the duration of one sync.

**Cost.** Four cold syncs on a fresh deployment — years, manufacturers, sets
(one `syncSetsAcrossManufacturers` call for the whole year) and variant types —
plus the forced `Sync Sets`. Measure it before adding anything to this flow; it
is budgeted against the 600s per-flow kill in `run-e2e-queue.sh`.

**Two taxonomy facts this fixture pinned down**, both worth knowing before
choosing any future real set:

* `EntitySelector` renders a column's search input only **above 8 entries**
  (`showSearch = sortedItems.length > 8`), not "more than one" as older comments
  in `flows/set-selector/` claim. A three-set column has no input at all, so any
  drill that assumes one will hang on a `.*Search sets.*` wait.
* An **empty** column renders its `Sync <X>` / `+ Custom` buttons immediately and
  only switches to the `Syncing <X>` panel once `ensureSelectorOptions` has
  round-tripped. So "the idle button is visible" is NOT proof the column has
  data — a probe on 2026-09-03 dumped an empty Sets column at exactly that
  moment. `util-drill-to-cold-real-set.yaml` waits out the `Syncing <X>` panel
  before gating on content, for that reason.

### 1996 Score — approved for NEO-137, sole-writer

Added with owner approval for NEO-137 Phase 5. It is the ONLY set in the
catalog that exhibits the shape the feature exists for, so the feature cannot
be end-to-end tested without it:

| source | set | cards |
| -- | -- | -- |
| BSC | Dugout Collection Artist's Proofs Series 1 | 110 |
| BSC | Dugout Collection Artist's Proofs Series 2 | 110 |
| SportLots | Dugout Collection Artists Proofs | 220 (`#A1-`, `#B1-`) |

BSC splits the Artist's Proofs into two series; SportLots carries one combined
set. Proving that ONE NeonBinder set can map to BOTH BSC sets and that single
SportLots set is the acceptance criterion of NEO-137, and no other registered
set can express it.

**What the flow leaves behind** (this IS the contract — the flow reconciles on
every run, so these are the values it re-establishes):

| | |
| -- | -- |
| NB insert rows | exactly ONE, built as `Dugout Collection Artists Proofs` |
| its BSC mappings | both series |
| its SportLots mappings | the one combined set |
| its card checklist | **220** cards, every one paired across both marketplaces |
| its FIRST card's name | carries a `NB203-<ATTEMPT_ID>` marker (NEO-203, below) |
| its NB insert row's name | carries a ` NB211-<ATTEMPT_ID>` suffix (NEO-211, below) |

**NEO-203 — the flow now re-syncs the set once more before it ends.** Its
STEP 7 edits the first card's name in NeonBinder, re-fetches the same
checklist, and declines the marketplace's competing name in the re-sync review
dialog. Two consequences worth knowing:

* The set is left with **220 cards still**, but the first card's NeonBinder
  name carries the run's `ATTEMPT_ID` marker. Nothing else reads that card, and
  `setup.yaml`'s reset clears it at the head of every run, so it accumulates
  only across local re-runs that skip a reseed.
* This is the ONLY end-to-end coverage of the re-sync content-diff review, and
  it lives here rather than in its own flow because the costly part of testing
  a re-sync is having a committed marketplace-backed set to re-sync — which
  this flow has just built, and which the sole-writer rule below forbids a
  second flow from building.

**NEO-211 — the flow now also re-syncs the INSERT LEVEL once, after all of
that.** Its STEP 8 renames the single insert row (appending ` NB211-<ATTEMPT_ID>`),
forces `Sync Inserts`, saves the reconcile dialog with no edits, and then
DECLINES both marketplaces' competing names in the new Name Suggestions dialog.
Consequences worth knowing:

* The set still ends with **exactly ONE** insert row and **220** cards. Only the
  insert row's NAME changes, and it changes to a per-attempt marker for the same
  reason the NB203 card marker does — it has to be unmistakably ours and unique
  to the run. `setup.yaml`'s reset clears it at the head of every run.
* The row also ends with `declinedUpstreamLabels` set on both sides, which is
  what makes the marketplace stop suggesting those names. Nothing else reads
  that field.
* This is the ONLY end-to-end coverage of the DECLINE half of the selector-sync
  suggestion dialog (Accept is covered on 1972-73 Topps Hockey, below), and of
  `storeReconciledOptions` being additive across a re-sync. It lives here for
  the same reason STEP 7 does: the costly part is having a committed,
  two-BSC-source insert row to re-sync, and the sole-writer rule forbids a
  second flow from building one.

**NEO-219 — STEP 9 opens the detach confirm on one BSC source and CANCELS.**
It presses the `×` on `Dugout Collection Artist's Proofs Series 1`, reads back
"110 cards were fetched from it" (the per-SOURCE count, which only this
two-source set can distinguish from the row's 220 total), and then presses
Cancel. **Nothing is detached.** The set is left with both BSC sources, the one
SportLots source and 220 paired cards — exactly as STEP 8 leaves it. This step
lives here for the same reason STEPs 7 and 8 do: the shape it needs (one NB row,
two sources, a known split) exists nowhere else, and the sole-writer rule below
forbids a second flow from building it.

220 is also the fan-out regression guard. BSC does not OR multi-value facets:
before `fetchBscChecklist` fanned out one request per source set, this exact
configuration returned 200 OK with zero rows and the UI reported "0 BSC cards".
A count of 110 means only one BSC source was fetched. Do not loosen it.

**Sole-writer, not read-only.** Unlike the Topps Chrome anchor, this set is NOT
pre-synced by `setup.yaml` and is NOT read-only: the reconciliation IS the
thing under test, so the flows must perform it.

Exactly ONE flow may ever touch this set —
`inserts-1996-score-one-nb-set-two-bsc-sources.yaml`. Adding a second would
reintroduce the cross-runner interference the read-only rule exists to prevent.

It was briefly split into a producer/consumer pair on the old `provides:`/`requires:`
dependency graph. That was wrong, and the graph is gone (NEO-260): nothing
schedules one flow after another. `run-e2e-queue.sh` enqueues in LPT order
(alphabetical without timing history) and 8 runners claim from a shared queue
with no dependency handling. Any flow in that queue must be independent of every
other. Keeping it out of `setup.yaml` also means its sync cost is paid by one
flow rather than added to every run's seed.

**No other real set exists in the suite.** If a flow needs marketplace-backed
data that isn't in the table above, it must either sync it itself (and accept the
30–90s cost, with owner approval) or — far more often the right answer — use a
per-worker custom set (see below).

### The one sanctioned read-only visitor

`checklist-pairing-dialog-cancel` (NEO-137, extended by NEO-189) syncs
`Insert → Future Stars` on the real anchor and then **cancels** the card-pairing
dialog. Cancel returns before `commitCardChecklist`, so nothing is written and
the set is left exactly as `setup.yaml` provisioned it — it reads, it does not
write.

Since NEO-189 it also unlinks two of the auto-matched pairs and cross-links
their halves, to raise the name-conflict warning on a merged row. That is still
read-only: unlink / link / choose-name are all `CardPairingModal` reducer state,
and the flow still exits through Cancel, which discards the candidate batch
without touching `cardChecklist`.

It should stay the ONLY flow that fetches this set. **Do not add a second Future
Stars fetcher; extend this flow instead.**

The reason is now cost, not corruption. This paragraph used to say that
`startCandidateBatch` cleared every `checklistCandidates` row for a
`selectorOptionId` globally and that `getReadyCandidates` was not user-scoped, so
two runners could empty each other's live candidates mid-review. Both were true
when this was written and both were fixed in the same branch (`d553bc8`) — the
clear and the read are now scoped to the operator who fetched, and each runner
signs in as its own `dev+e2e-<N>` user. What remains is ~90s of live BSC/SL
round-trip per fetch, which is reason enough not to pay for it twice.

It cannot use a hand-made set: a hand-made subtree carries no marketplace ids,
so neither side is resolvable and neither is fetched (NEO-239) — it produces no
candidates, and `CardChecklist` deliberately skips the pairing dialog when all
three buckets are empty. The dialog is only reachable with real marketplace
data.

NEO-137's Phase 5 also calls for a full 1996 Score map-out. That needs a NEW
real set and therefore explicit owner approval — it is **not** in the suite.

### READ-ONLY means read-only

No flow other than `setup.yaml` may add, edit, or delete cards, players, teams,
or variants on a real set. This is not a style preference: the E2E work queue
drains dynamically across 8 parallel runners, so any write to a shared set is
visible to whichever other flows happen to be running at that moment.

`fetchCardChecklist`'s custom-card pending-name pass reads **all** custom cards on
a `selectorOptionId` **globally** — there is no author scoping. A custom card
added to a shared set therefore seeds *other* workers' entity-review batches.

This was violated by two entity-review flows (since retired — see below) that
added cards `9001-*` / `9002-*` to 2024 Topps Chrome Base on every attempt and
never cleaned up. CI run `30505189226`: one of them (runner 4) left
`CDPlayerA/CDPlayerB-r4-a1-27829` behind at 01:30:33; 91s later the other
(runner 2) opened its wizard on 3 unknowns instead of its own 1 and failed.
Accumulated junk also showed up directly in the UI — "Cards (337)" against
"Found 335 cards". Both were moved onto per-worker custom sets at the time.
`NEO-109` (read-only `signed-by-autofills-from-players` failing on card #300) is
very likely the same pollution. Keep the lesson: the fix for a flow that needs
to write is a per-worker custom set, never "clean up afterwards".

### Retired: the six quick-add entity-review flows (NEO-220/221, 2026-09-05)

`checklist-fetch-cancel-dialog`, `checklist-fetch-unknown-entities-link-existing`,
`checklist-fetch-wizard-add-career-team`, `checklist-fetch-wizard-back-and-resume`,
`checklist-fetch-wizard-skip-not-a-person` and `checklist-keyboard-only-dialog`
(prefixes `fcd-`, `lce-`, `cte-`, `wbr-`, `skp-`, `kod-`) all reached the entity
review wizard the same way: type an invented name into the quick-add form's
free-text Players field, sync, and let the resulting `pendingPlayerNames` open
the wizard.

That path no longer exists. Quick-add's Players field is a **PlayerPicker**, so
a hand-added card is born linked (`playerIds`) and never carries a pending name
— the sync commits immediately and no wizard appears. The flows fixtured a
product path the product no longer has, so they were deleted rather than
rewritten around a fiction.

Wizard coverage now lives in two places: the unit files
(`EntityReviewWizard.test.tsx` cancel/back/Enter blocks, `entityReviewQueue`
resume tests, `entityReviewSkips`, `SkippedNamesPanel`) and — for the live,
end-to-end path — STEP 6 of `inserts-1996-score-one-nb-set-two-bsc-sources.yaml`,
which opens the wizard on a genuine cold two-source fetch and now also covers
decide → Cancel (Esc) → "Discard 1 decision?" → keep, and the Enter commit.

Do not re-create them **the way they were written**: a marketplace-free subtree
cannot produce an unknown name any more.

**NEO-248 brought the coverage back on a REAL set.** The wizard opens only on
names a marketplace fetch returned that NeonBinder does not already hold, and
only **BSC** returns names at all — so the fixture has to be a real,
BSC-listed set, synced through the real hierarchy. It is
`Baseball → 2024 → Topps → Topps Big League → Base`; read its section below
before touching any of these four.

| flow | what it owns |
|---|---|
| `checklist-wizard-back-to-matching-resumes-decisions` | "Back to matching" parks the review; re-confirming resumes the SAME batch with its decisions |
| `checklist-wizard-skip-not-a-person` | the per-row skip, and "Skip Remaining" deciding every row that is left, lookups included |
| `checklist-wizard-link-to-existing-player` | "Link to Existing" resolves onto a roster player instead of minting a duplicate |
| `checklist-wizard-career-team-entry` | the inline career-team mini-form on a player row, and the decision it feeds |

all sharing `util-fetch-real-set-checklist-to-wizard.yaml`, and all four
READ-ONLY (Cancel → Discard).

Three SIBLING flows cover the **commit** side — what a decision is worth once it
is saved — and each gets its own real set so it can write without racing
anything:

| flow | fixture |
|---|---|
| `checklist-wizard-skip-commits-and-unskip` | Topps Chicago Cubs |
| `checklist-wizard-career-team-commits` | Topps Baltimore Orioles |
| `checklist-wizard-link-commits` | Topps Brooklyn Collection |

See "The three COMMITTING entity-review fixtures" below.

**They no longer own a custom-set prefix.** `wbr-`, `skp-`, `lce-` and `cte-`
are retired along with `fcd-` and `kod-`: these flows create nothing. The
discard confirm and the Enter commit live in STEP 6 of
`inserts-1996-score-one-nb-set-two-bsc-sources.yaml`.

### The three COMMITTING entity-review fixtures — one set per flow (NEO-248) ✅ APPROVED

The four `checklist-wizard-*` flows on Topps Big League are read-only: they
prove the wizard's decisions and always exit through Cancel → Discard. Three
sibling flows prove what happens when a review is **committed**, and each one
gets its **own real set**.

| flow | fixture | shape | measured unknowns |
|---|---|---|---|
| `checklist-wizard-skip-commits-and-unskip` | Baseball → 2024 → Topps → **Topps Chicago Cubs** | 17 cards, matched both sides | **11 — all players, 0 teams** |
| `checklist-wizard-career-team-commits` | Baseball → 2024 → Topps → **Topps Baltimore Orioles** | 17 cards, matched both sides | **8 — all players, 0 teams** |
| `checklist-wizard-link-commits` | Baseball → 2024 → Topps → **Topps Brooklyn Collection** | 50 cards, matched both sides | **12 — 11 players + 1 team** |

All measured live on PR #235's preview, 2026-09-06: each syncs its variant types
cleanly (a single `Base`, no reconcile dialog), each maps cleanly on BOTH sides,
and each opens the wizard on a player row.

#### ⚠️ BOTH SIDES MUST BE MAPPED — the rule that broke CI run 34045516761

An earlier version of these fixtures mapped Base on **BSC only**, to avoid
attaching a wrong SportLots set. That cannot work, and the reason is a
deliberate product rule rather than a bug: `baseHasMapping` in
`components/modules/SetSelector.tsx` is `slotIds(row, "sportlots").length > 0`.
Only the SportLots slot is exclusively written by `BaseSetPicker` — the BSC slug
is auto-populated by "Sync Variant Types", so testing it would suppress the
auto-prompt on every freshly synced Base.

A BSC-only mapping therefore never counts as mapped:

* `Re-map Base` never renders (the seed's own assertion failed on this), and
* `BaseMappingForm` keeps auto-opening its picker on every fresh mount, which
  would block the checklist for whichever flow arrived next.

**So a fixture set must be one whose SportLots side has a real counterpart**,
and specifically one where the picker's FIRST candidate is correct — that is
what `util-drill-to-base-variant` picks. Measured: `Baltimore Orioles`,
`Chicago Cubs` and the Brooklyn Collection match all rank first. Two Panini
basketball sets were dropped for exactly this: their SportLots lists are ~3111
rows whose top matches were unrelated ("Caitlin Clark Collection" variants), so
they could only ever have been mapped BSC-only.

#### Concurrency: one set, one writer — parallel-safe by construction

**CI cannot serialize two flows.** `run-e2e-queue.sh` filters only
`util` / `wip` / `setup`; the `isolated` and `serial-marketplace` lanes exist
ONLY in `run-e2e-smoke.sh`, the local runner, and nothing orders one flow after
another anywhere. So there is no lane to put a writer on, and "sole writer" has
to be structural rather than scheduled.

It is: **each of these three sets is touched by exactly one flow, and no flow
reads another's set.** Different sets share no `selectorOptionId`, no
`cardChecklist` rows and no skip records, so the three commit concurrently with
each other, with the four read-only Big League flows, and with everything else,
without interfering. Nothing needs restoring afterwards.

**They do drain their own fixtures, and that is accepted.** Committing makes
that set's players known, and a known name never reaches the wizard again — so a
second run against the same un-reseeded deployment would open on nothing. CI
reseeds the preview every run, so the drain never outlives one run. A local
re-run needs a fresh seed — rerun `npm run test:e2e -- setup`.

#### Why these sets, specifically

* **Team sets have unknown players.** `setup.yaml` only ever creates the ~494
  players from 2024 Topps Chrome — its 200-card base plus two inserts — so a
  team set's commons sit outside that roster. Measured 8–12 unknowns each.
* **The link flow needs BASEBALL specifically.** `EntityLinkSearch` queries
  `players.search({ query, sportId })`, scoped to the row's sport, so the link
  TARGET must share the fixture's sport. `Link to Shohei Ohtani` resolves on
  Topps Brooklyn Collection (verified live) while its own 11 players stay
  unknown. All three fixtures are baseball anyway, which also keeps the seed
  cheap — no second sport to cold-sync.
* **Two of the three surface NO unknown teams at all**, so the flows that act on
  player-only controls (career-team) need no kind guard and pay no poll for one.
  Only the link flow's fixture has a team (1 of 12), and it keeps its guard.
* **Name-collision note.** `Topps Chicago Cubs` is a strict prefix of
  `Topps Chicago Cubs Season Ticket Holder`. That is safe: the drill selects by
  `text:`, which Maestro anchors to the whole node, so it cannot match the
  longer row. Only `id:` selectors are regex finds.

#### Each flow provisions its OWN set — the seed does not

`setup.yaml` deliberately provisions NOTHING for these three. Doing so cost
~2 minutes of SERIAL seed time and pushed the seed past its 600s wall
(run 34048184342); the seed runs once, before every runner starts, so anything
added there taxes every PR.

Instead each flow provisions its own set on its own runner, in parallel.
`util-fetch-real-set-checklist-to-wizard.yaml` already handles the cold
first-time path with no extra step: the warm drill's closing
`visible: "Base"` (60s) covers the cold variant-type sync, and
`util-drill-to-base-variant.yaml`'s `when: visible "Select Base Set"` branch
maps BOTH sides (45s) and is simply skipped once the set is mapped — so it is
idempotent. Measured cold, end to end: 98s / 104s / ~110s against a 600s
per-flow timeout (`MAESTRO_FLOW_TIMEOUT_SEC` in `run-e2e-queue.sh`).

**Never fetch these sets in the seed**: it would create their players and empty
every wizard they exist to fill.

#### A re-sync raises no entity review — do not assert on one

Measured twice: once a set's checklist is committed, re-syncing it produces no
entity review at all, whatever decisions were taken. Any assertion of the form
"resolve a name once and it stops being asked about" therefore passes
regardless of what it claims to prove, and an earlier version of the link flow
carried exactly that. It also means these flows need a set that has never been
committed on the deployment — which CI guarantees by reseeding every run, and
which a LOCAL re-run does not: re-running one of these against an
already-committed preview fails at the wizard wait, correctly.

### Topps 206 — the unmapped-Base fixture for `base-mapping-cancel-recovers` (NEO-248) ✅ APPROVED

`base-mapping-cancel-recovers` needs a real set whose **Base is UNMAPPED**, so
that selecting Base auto-opens `BaseSetPicker` and the Cancel → message → Retry
recovery can be exercised. It used to use `Topps Big League`; it cannot any
more, because Big League is now the wizard fixture and `setup.yaml` maps its
Base in the seed job. A mapped Base renders `Re-map Base` instead of opening the
picker, and the flow fails on its first assertion — CI run 34006917636.

**The two needs are irreconcilable on one set** (one requires Base unmapped, the
other requires it mapped), so they get different sets.

Verified live on PR #235's preview, 2026-09-05:

| | |
| -- | -- |
| variant types | `Base` (BSC pill), `Insert`, `Parallel` — clean sync, no reconcile dialog |
| Base state | UNMAPPED — "BSC — No sets attached" |
| picker | auto-opens with `Topps 206 — set listing (BSC)` pre-filled; SportLots candidates `206` and `Base Set`, both "likely match" |
| cancel | "Base mapping cancelled — nothing was linked. Click Retry to pick a set, or Close to leave it unmapped" + a working `Retry` |

**It writes nothing.** The flow cancels twice and never confirms, so Base is
still unmapped when it finishes — idempotent, no restore step needed. **No other
flow may map this set's Base**, or this one loses its precondition the same way
it just did.

**Name-collision note.** `Topps 206` is a strict prefix of `Topps 206 NPB`. That
is safe for the drill because Maestro `text:` matchers are full-node-anchored;
only `id:` selectors are regex FINDS. (`Topps 206 NPB` itself is unusable as a
fixture — it has only an `Insert` variant type and opens a 2534-row
`Reconcile Inserts` dialog on first drill.)

### The ONE-MARKETPLACE fixture — Hockey / 1995 / All Brands / Roanoke Express ECHL (NEO-255) ✅ APPROVED

> **Approved by Jason, 2026-09-09 (NEO-260).** This section previously said the
> flow would keep its `wip` tag until approval landed. It never carried one —
> nothing excluded it and it had been running on every PR regardless, which is
> how the gap was found. The `wip` note and the NEO-258 stall rationale are both
> stale and are struck; the flow runs in the full suite like any other.

**What was asked for:** one new real set —
**Hockey → 1995 → All Brands → Roanoke Express ECHL**, `Base` — touched by
exactly one flow, `checklist-one-marketplace-skips-match-dialog.yaml`, which
fetches and COMMITS its 25-card checklist. Everything below was measured live
on PR #242's Convex preview (`fine-egret-808`) on 2026-09-07, so the decision
can be made on numbers rather than on a guess.

`checklist-one-marketplace-skips-match-dialog.yaml` proves the NEO-255 rule:
when exactly ONE marketplace is **attached** to a set, "Sync card checklist"
skips the Match Cards dialog, keeps every fetched card as a single-marketplace
card ("BSC only"), and goes straight to the entity review with **no "Back to
matching"**.

**There is currently ZERO one-sided coverage.** Every flow in the suite that
reaches the pairing dialog — `setup.yaml` ×3, `checklist-pairing-dialog-cancel`,
`util-fetch-real-set-checklist-to-wizard` and its four `checklist-wizard-*`
callers, the three `*-commits` siblings, `inserts-1996-score` — is on a set with
BOTH sides attached. They cover the ≥2 half of the rule, which this ticket does
not change; none of them can express the =1 half.

| | |
| -- | -- |
| ancestors | `Hockey → 1995 → All Brands` |
| set | **Roanoke Express ECHL** |
| variant type | `Base` (the set's ONLY variant type — clean sync, BSC pill, no reconcile dialog) |
| checklist | **25 cards**, all BSC-only — FETCHED and **COMMITTED** by the flow |
| unknown names | **25 — all players, 0 teams** ("25 new players + 0 new teams need confirmation", "0 of 25 reviewed"), stable for 27s after the wizard opened |
| Base mapping | left **UNMAPPED** on SportLots, on purpose — the flow cancels the picker |
| writer | `flows/set-selector/checklist-one-marketplace-skips-match-dialog.yaml`, **sole writer** |
| pre-synced by `setup.yaml` | **no** — the flow pays its own cold syncs, on its own runner, in parallel (the NEO-248 rule: nothing goes in the seed) |

#### The measurements, against the ten questions this section used to ask

1. **The year.** Hockey's Years column holds **122 plain four-digit rows,
   1905–2026** — no `1994-95` form anywhere. 1995 was taken and is populated.
2. **The seed brand — NOT NEEDED, and the old drill was wrong.** The registry
   used to say "All Brands" is minted by `syncSetsAcrossManufacturers` and so
   cannot be selected until some other manufacturer's Sets column has mounted,
   which is why the flow drilled twice. **Measured: false for Hockey.** The
   Manufacturers column for 1995 comes back as `All Brands, Bowman, Classic,
   Donruss, Finest, Fleer, ITG, O-Pee-Chee, Pacific, Panini, Pinnacle, Score,
   Skybox, SP, Stadium Club, Topps, Ultra, Upper Deck` — 18 rows, `All Brands`
   among them, straight off the SportLots brand list and before any Sets column
   has mounted (1997 returns the identical list). One drill pass is enough and
   the flow now does one.
3. **The set.** `All Brands` for 1995 holds **134 sets**. `Roanoke Express ECHL`
   was picked as a small, regex-safe, obviously-minor-league one: **25 cards**.
   (`Dayton Bombers ECHL`, 32 cards, was measured end-to-end as the pilot and is
   therefore already committed on that preview — see "spares" below.)
4. **The base picker — ⚠️ THE PROPOSAL'S STATED PREMISE IS DISPROVEN.** This
   section used to claim SportLots "cannot even be *offered* at the base picker"
   because All Brands carries no marketplace ids, and the flow asserted the
   picker's `SportLots returned no base set for <set>` line as its precondition.
   **Measured: the picker shows 1 BSC candidate
   (`Roanoke Express ECHL — set listing (BSC)`) and 321 SportLots candidates,
   and that line never appears.** All Brands is a real SportLots brand row, so
   it carries a SportLots id and the whole 1995 SportLots catalogue is
   offerable underneath it.
   **The fixture is still correct, for a different reason.** `attachedSidesOf`
   counts a SportLots id only on a row at `setName | variantType | insert |
   parallel` (`SL_SET_LEVELS`) — a MANUFACTURER's id is explicitly not enough.
   The set row and its `Base` row carry a BSC id and no SportLots id, and the
   flow cancels the picker rather than attaching one, so the sync sees exactly
   one attached side. The flow's precondition assertion was rewritten to what is
   actually true (`BSC base candidate: …` exists), and the one-sidedness is
   asserted by the product's own words at the result line.
5. **The entity-review wizard.** Opens, on a **New Team** or player row, ~0.8s
   after the fetch resolves. 25 unknown names, all players. Footer offers
   `Add remaining players as new (25)` / `Skip remaining names (25)` /
   `Cancel (Esc)` and — the point of the ticket — **no `Back to matching`**.
6. **The count chain — all four agree.** Measured on the pilot set
   (`Dayton Bombers ECHL`, 32 cards): `Kept all 32 cards from BSC. Nothing to
   match, no other marketplace attached.` → `All reviewed — save 32 cards?` →
   `Saved 32 cards.` → header `Cards (32)`.
7. **The badge — NOT YET OBSERVED.** `candidateToPairingCard` maps bucket
   `bscOnly` → `unmatched: "sl"`, `commitCardChecklist` writes the
   `unmatched-sl` attribute and `CardChecklistItem.badgeLabel` renders it as
   `BSC only`, so the assertion is right by construction — but the checklist's
   Virtuoso list renders no rows in the probe browser (it renders none for
   2024 Topps Chrome's 335 cards either, so that is the probe harness, not the
   product), and the Maestro run is blocked before it (below). **The one
   unverified assertion in the flow.**
8. **SL-pane substring collisions.** None. `SL only` appears nowhere on either
   screen (0 occurrences on the committed checklist page). The base picker's
   rows are `aria-label="SportLots base candidate: <name>"`, which no assertion
   in the flow touches. The `MultiSourcePanel` renders `No sets attached.` under
   BOTH its BSC and its SPORTLOTS column, side by side at the same y — still
   deliberately not asserted on.
9. **The progress line — TOO SHORT TO ASSERT, and that is a finding, not a
   flake.** Recorded at 250ms resolution:

   | fixture | line appears | denominator appears | replaced by the result |
   |---|---|---|---|
   | Roanoke Express ECHL (25 cards) | t=0.12s | t=1.12s (`0 of 25 cards ready.`) | t=1.37s |
   | Dayton Bombers ECHL (32 cards) | t=0.13s | t=2.38s (`0 of 32 cards ready.`) | t=3.13s |

   So the whole `Fetching from BSC… <n> of <m> cards ready.` sentence is on
   screen for ~1.3s / ~3.0s and the `<n> of <m>` half for ~0.25s / ~0.75s, and
   the numerator never left 0. maestro-web spends ~2s per step in
   `hierarchyBasedTap`'s view-hierarchy wait, so the window is gone before the
   command after the tap can read the screen. Widening it needs a fixture of
   hundreds of cards, which this flow then has to review and commit. **The flow
   therefore does not assert the inline progress line at all**, says so in its
   header, and leaves that line to the `soloProgressMessage` unit tests. It
   also does not assert `Cancel checklist fetch`, which lives and dies in the
   same window. The sentence does not begin with `Match Cards` or `Saved <n>`,
   so it collides with nothing.
10. **Measured cost.** Against the 600s per-flow kill in `run-e2e-queue.sh`, on
    a cold preview: drill to the year ~30s (SportLots years + manufacturers),
    Sets column ~20s, variant types ~15s, base picker ~8s, checklist fetch
    1.4s, wizard 2s, `Skip remaining names` → `All reviewed` 0.5s, commit 1.2s
    (with a further ~15s tail as the attention count climbs to 25). The Maestro
    run reached the base picker's cancel at **t≈95s** including sign-in, so the
    whole flow should land near **~2 minutes** — comfortably inside the budget,
    and in the same band as `checklist-pairing-dialog-cancel` (2m29s, measured
    on the same preview the same evening).

#### The base-mapping panel: Close now dismisses it, and the flow taps it

Since 2026-09-08 (`0411cd8`, `13deac4`) pressing **Close** on the
"Base mapping cancelled — nothing was linked…" panel actually dismisses it for
that variantType and hands back a primary **`Map Base Set`** button; the page
also carries `pb-[50vh]` of scroll headroom. The flow uses both: it cancels the
picker, asserts the cancelled-mapping message, presses **Close**, and then
asserts the panel is gone and `Map Base Set` is offered. That last assertion
earns its place twice over — it is the positive proof that Cancel left the row
**unmapped**, because a Base that had picked up a SportLots mapping would read
`Re-map Base` instead, and the whole one-marketplace precondition would be gone.

All of that is verified green under Maestro on PR #242's preview. Two sibling
flows were re-run on the same build to prove the new button label collides with
nothing: `base-mapping-cancel-recovers` (53s) and
`checklist-wizard-skip-not-a-person` (6m14s), both of which gate on
`.*Select Base Set.*|.*Re-map Base.*` — `Map Base Set` matches neither.

#### ⛔ STILL NOT GREEN: a headless-Chrome frame stall, not the app

Root cause found on 2026-09-08 and written up in
`.claude/agent-memory/neonbinder-web-dev/reference_maestro_web_frame_stall_kills_scrolling.md`:
maestro-web's only scroll primitive is `window.scroll({behavior:'smooth'})`,
which is frame-driven, and headless Chrome's renderer stops producing frames at
the set-selection render (rAF 0 ticks in 2s while `setInterval` fires ~125).
Every scroll then moves 0px and still reports COMPLETED. It is not the app and
not this fixture — Topps Big League stalls at the same step.

The flow was rewritten to use **no scroll primitive after the set is selected**;
the one that remains is in STEP 2, before the set is picked, where frames are
still alive. That is not enough, because the checklist is below the fold and
maestro-web's element lookup is **viewport-bounded**, so it cannot be tapped or
asserted either. Measured at 1024x625, panel dismissed, app parked at scrollY 42:

| | document | on screen | |
|---|---|---|---|
| `Map Base Set` | 461–493 | 419–451 | ✅ |
| `Multi-source sets` | 534–554 | 492–512 | ✅ |
| `Cards` / `Add Card` | 809–841 | 767–799 | ❌ |
| `No cards in this checklist yet.` | 881–905 | 839–863 | ❌ |
| `Sync card checklist` | 921–953 | 879–911 | ❌ 254px under |

Four routes were tried and recorded in the flow's STEP 4 so they are not
retried: a direct `assertVisible` on the below-the-fold text (fails —
`Assertion is false: "No cards in this checklist yet." is visible`); the
keyboard (maestro-web supports ENTER and BACK_SPACE only, so focus cannot be
walked down with Tab); a pre-selection scroll (the app re-scrolls on every
column reveal — max 719 before the set becomes 219 after, and the sequence
settles at 42); and a scrollbar-track click (`tapOn: point: "99%, 85%"` landed
at (1013, 531) twice, hierarchy still `root=[0,0]`).

**The unblock is in the harness.** The same run scrolls and finishes green with
a second CDP client attached for its duration, which prevents the stall. The
flow keeps its `wip` tag until that lands; nothing about the fixture is in
question — every number in this section was measured on it.

#### Why the fixture has to be REAL

A hand-made subtree carries no marketplace ids on any ancestor, so neither side
is resolvable, neither is fetched (NEO-239), and `fetchCardChecklist` returns
`candidateCount: 0`. `CardChecklist` has skipped the dialog on that path since
NEO-137 — **it would pass whether NEO-255 shipped or not**, which is exactly
the R2 fall-through this fixture exists to avoid. The feature only exists where
one marketplace genuinely answers.

`syncSetsAcrossManufacturers` is BSC-only and files every BSC set whose name
prefix-matches no SportLots brand under "All Brands" — the minor-league,
junior, college and team sets. Those sets get a BSC id and no SportLots id, at
any level a SportLots attachment can live on, which is what makes them
one-sided. (See item 4 above for what is NOT true of "All Brands".)

#### Sole writer — and why this one cannot be read-only

The four `checklist-wizard-*` flows share Topps Big League because they all exit
through Cancel → Discard. **This flow cannot.** The defining outcome of NEO-255
is that the cards are *kept*, and that is only observable after a commit: a
build that skipped the dialog and then committed nothing would pass a read-only
version of this flow. So it commits, on the 1996-Score / `*-commits` model —
its own real set, exactly one flow touching it, no flow reading it. Different
sets share no `selectorOptionId`, no `cardChecklist` rows and no skip records,
so it runs concurrently with everything else and nothing needs restoring.

It resolves every unknown name as a **skip** before committing: skips create no
players and no teams, so the commit mints nothing global, raises none of
NEO-236's per-team `New Team` steps, and leaves only this set's own cards and
skip records behind.

**It drains its own fixture**, deliberately and acceptably. After the commit the
set holds cards, so the next sync is a RE-sync (content-diff review, not a first
fetch) and its names are known. CI reseeds the preview every run, so the
first-fetch path is the CI path; a LOCAL re-run against an already-committed
deployment fails at STEP 4's `No cards in this checklist yet.` assertion,
correctly; the fix is a fresh `npm run test:e2e -- setup`. **A local validation therefore gets
exactly one committing attempt per set per deployment.**

#### Spares, if the set ever has to be swapped

Same shape, same ancestors, all verified present in the 134-set column and all
regex-safe: `Dayton Bombers ECHL` (**32 cards — already committed on PR #242's
preview by the pilot probe, so it is spent there**), `Dunkin Donuts Portland
Pirates AHL`, `Tulsa Oilers CHL`, `Memphis RiverKings CHL`,
`San Antonio Iguanas CHL`, `Fort Worth Fire CHL`, `Halifax Mooseheads QMJHL`.
Swapping is a one-line edit to `output.SET` in the flow's STEP 0 plus the two
name literals in this section. Avoid names carrying regex metacharacters or a
`/` (`Electrolarm/Z-104 …`, `Kellogg´s …`).

### Topps Big League — the entity-review wizard fixture (NEO-248) ✅ APPROVED

`Baseball → 2024 → Topps → Topps Big League → Base` is the fixture for the four
`checklist-wizard-*` flows. It is a REAL, marketplace-listed set: it appears in
the Sets column via `Sync Sets`, its variant types sync normally (`Base` with a
BSC pill, `Insert`, `Parallel` — no reconcile dialog), and its Base maps
cleanly. Nothing about it is hand-made.

**Measured live on PR #235's preview, 2026-09-05:**

| | |
| -- | -- |
| Base pairing | **310 matched**, 0 BSC-only, 1 SportLots-only (`#228 John Doe`), 1 name conflict |
| unknown names | **88 — 87 players + 1 team** ("0 of 88 reviewed") |
| first row presented | a PLAYER (`Taylor Ward`, Wikidata Q56169880), *"No career-team history found."* |
| controls present | `Add as New Player`, `Link to Existing…`, `Skip — not a person`, the career-team mini-form, `Back to matching`, `Add All Remaining as New (88)`, `Skip Remaining (88)` |
| cost | one live BSC + SportLots round-trip per flow (~40s fetch, ~30s to the wizard) |

**Why this set and not a hand-made one.** Three designs are dead and must not be
re-attempted:

1. A hand-added card's `pendingPlayerNames` — quick-add's Players field is a
   PlayerPicker now, so a hand-added card is born LINKED (NEO-220/221).
2. A hand-typed set with a **SportLots** set id attached.
   `fetchSportLotsChecklist` declares `players`/`teams` in its return validator
   but never sets them (see the doc comment on `tokenizeSlDescription`), so a
   SportLots-only fetch yields **zero** unknown names for any set — measured:
   `Big League Gameday Drip` committed 10 of 10 cards with no wizard, and the
   mascot sets did the same at 26 of 26. **Unknown names come from BSC.**
3. Creating a row with `+ Custom` and attaching marketplace data to it —
   rejected on product grounds: hand-creating a set exists only to AVOID
   syncing, so a test that syncs must sync through the real hierarchy, and
   `Base` is not something an insert set has.

**Why its players are unknown.** `setup.yaml` commits 2024 Topps Chrome's Base,
Future Stars and Gold Wave players (~494 rows). Big League's base is a different
player pool — current players, prospects and veterans outside Chrome's 200 — so
87 of its 88 names are new. That is the fixture, and it is fragile in exactly
one way:

> ⚠️ **NOTHING MAY EVER COMMIT THIS SET'S CHECKLIST.** A commit creates those 87
> players, and a name that is known is not an unknown — the next fetch opens the
> wizard on nothing and all four flows fail. `setup.yaml` therefore provisions
> the **structure only** (variant types + Base mapping) and asserts the
> checklist is still empty. Do not "warm" this set the way Topps Chrome is
> warmed: Topps Chrome is warmed so its players ARE known, and this set exists
> to be its opposite.

#### Concurrency: four readers, ZERO writers

All four flows exit through **Cancel → Discard** (`cancelBatch`). None commits,
none chooses "Add as New" through to a save, none writes a card, player, team or
skip record. That is what makes four flows on one shared set legal, and it is
not a style preference — it is the only safe design available, because:

* **CI cannot serialize two flows.** `run-e2e-queue.sh` filters only
  `util` / `wip` / `setup`. The `isolated` and `serial-marketplace` lanes exist
  ONLY in `run-e2e-smoke.sh`, the LOCAL runner. "Sole writer" (1996 Score) is a convention enforced by review,
  not a runtime mechanism — there is no lane to put a writer on.
* **Concurrent reads are genuinely safe.** `startCandidateBatch` clears and
  reads `checklistCandidates` scoped to the operator who fetched, and
  entity-review batches are keyed by selectorOption + user. Each runner signs in
  as its own account.

The price is one live BSC+SL round-trip per flow. State the measured cost in any
PR that adds a fifth reader.

**What is NOT covered end-to-end, as a consequence**, and where it lives instead:

| behaviour | why not here | covered by |
|---|---|---|
| the `Skipped names` panel + Unskip | skip records are written by `commitCardChecklist`, not `recordDecision` | `entityReviewSkips`, `SkippedNamesPanel.test.tsx` |
| commit-time `resolveTeamIdByName` for a staged career team | same — needs a commit | entity-review unit files |
| the link surviving commit re-resolution | same | entity-review unit files |

Restoring any of those end-to-end needs a SECOND real set with a single
sanctioned writer — the 1996 Score shape. That is an owner decision; do not
reach for it by letting one of these four flows write to a set the other three
read.

**The kind guard.** Two flows (`link-to-existing`, `career-team`) act on
controls only a PLAYER row renders, and which row settles first is a race
between live Wikidata lookups. Each opens with a `when: visible: id: "Skip .* not
a team"` guard that skips a team row if that is what came up. On the 87-in-88
path the guard costs one poll and does nothing — a deliberate, documented R10
exception, taken because the alternative is a flake with no relationship to the
feature under test.


### Per-attempt custom SPORT rows — `custom-entry-survives-resync`, self-cleaning

`custom-entry-survives-resync.yaml` creates one custom SPORT row per attempt,
`TestCustomSport-<attempt>`, proves a marketplace re-sync does not delete it,
and — since NEO-219 — **deletes it again through the attributes header's delete
control** (STEP 4). It therefore leaves the Sports column exactly as it found it.
That delete is the flow's contract: if STEP 4 is ever removed, the flow goes back
to leaking one global sport row per run.

The row is safe to delete because it holds nothing — no years, sets, cards,
players or teams — which is the only condition `deleteSelectorOption` accepts.

## Custom sets

**A marketplace side is fetched only when the ids that side needs are present on
the ancestors** (NEO-239). BSC needs `sport`, `year` and `setName`; SportLots
needs `sport` and `year` (plus `manufacturer` to attach). A hand-made subtree
carries no ids on any ancestor, so neither side is ever resolvable, neither is
fetched, and it costs no marketplace sync at all — which is why the per-worker
fixtures below stay marketplace-free. This is the default choice for any flow
that needs to write.

This replaced NEO-22's "once custom, always custom" flag. There is no "custom"
mode any more: a row either carries marketplace ids or it does not, and the two
behave identically everywhere else — including in the entity-review wizard and
in rename, both of which now work on any row at any level. A missing id is never
guessed at from a display name; the side is simply skipped.

**Preferred shape:** a custom `SET_NAME` under the *real* `Baseball / 2024 /
Topps` ancestors. Keeping the real Sport ancestor means `fetchCardChecklist`
still derives `sport="baseball"` (`selectorOptions.ts` lowercases the sport
ancestor's value), so the real setup-synced Baseball roster stays available as
link targets and entity lookups behave as on a real set. A fully synthetic
`E2E Test Sport N` yields an empty roster and is only appropriate when the flow
genuinely needs a sport with no data.

Names are suffixed `-${WORKER_INDEX || 0}` so each of the 8 runners gets a
private `selectorOptionId`. Some flows additionally suffix `-${ATTEMPT_ID}`
where a retry must not observe its own prior debris — the two
`checklist-attention-*` flows (NEO-102) and
`checklist-title-length-limits-and-fixer.yaml` (NEO-101) do it because they
assert an EXACT count of the cards needing attention, and an exact count is
only knowable on a checklist this attempt created from empty. The NEO-101 flow
additionally names the card its walker must present, so a leftover flagged row
would put the wrong question on screen.

| Prefix | Owning flow |
|---|---|
| `attr-edit-` | `set-attributes-edit.yaml` |
| `cag-` | `card-autograph-always-visible-saves.yaml` |
| `cap-` | `card-autopopulates-features.yaml` |
| `ccrud-` | `custom-card-crud.yaml` |
| `cd-` | `card-detail-panel.yaml` |
| `cft-` | `card-features-editor-toggle.yaml` |
| `cna-` | `checklist-attention-badge-and-filter.yaml` (also `-${ATTEMPT_ID}`) |
| `cnw-` | `checklist-attention-walker-missing-team.yaml` (also `-${ATTEMPT_ID}`) |
| `clt-` | `custom-card-row-opens-panel-with-autotitle.yaml` |
| `cvar-` | `variation-link-group-and-unlink.yaml` |
| `fp-` | `features-propagation.yaml` |
| `parallel-feature-` | `cards-parallel-custom.yaml` |
| `pg-cancel-` | `parallel-grouping-cancel-discards.yaml` (also `-${ATTEMPT_ID}`) |
| `pg-move-` | `move-parallels-of-inserts-custom.yaml` |
| `pg-reject-` | `parallel-grouping-reject-parallel.yaml` (also `-${ATTEMPT_ID}`) |
| `pp-` | `player-picker-create-custom-card.yaml` |
| `rnm-` | `rename-selector-option.yaml` (also `-${ATTEMPT_ID}`; renamed in-flow to `rnmx-`) |
| `tlf-` | `checklist-title-length-limits-and-fixer.yaml` (also `-${ATTEMPT_ID}`) |
| `tp-` | `team-picker.yaml` |
| `tpc-` | `team-picker-create-custom-card.yaml` |
| `vme-insert-` | `variant-metadata-editor-insert.yaml` |
| `WOSet3-` | `new-chain-autopopulates-features.yaml` (under synthetic `E2E Test Sport N`) |
| `xag-`, `xsrc-` | `cross-release-card-appears-in-guest-checklist.yaml` |
| `xbg-`, `xbs-` | `cross-release-import-reports-missing-numbers.yaml` |
| `xcg-`, `xsrc-` | `cross-release-hide-toggle-filters-guest-cards.yaml` |
| `xdg-`, `xds-` | `cross-release-unlink-keeps-card-in-home-set.yaml` |
| `xp-` | `custom-set-exists-elsewhere-offers-drill.yaml` — its OWN sport `xp-sport-<worker>`, brand rows `xp-<worker>-A` / `xp-<worker>-B` under it in 2026, and a set `xp-<worker>-<attempt> Chrome` under B. **It must never use `E2E Test Sport <worker>`** — see the fold note below. |

`xsrc-` is intentionally shared between the two cross-release flows that both
need the same guest-source set; it is still per-worker.

### Adding ROWS to a shared column pushes other flows' controls under the fold

A per-worker custom SET is free. A per-worker custom **manufacturer, year or
sport row added under an ancestor other flows drill through is not** — it makes
that column taller for everybody.

The columns start at y≈380 (the Admin Tools block sits above them) and each row
is ~58px in the 1024×625 headless viewport, so a column's `Sync <X>` / `+ Custom`
buttons fall off the bottom at roughly the **fourth** row. `util-drill-to-custom.yaml`
waits for `Add custom <X>` **without scrolling** at several levels — a deliberate
guard against a CDP crash during re-render — so once those buttons are under the
fold the drill cannot recover and every consumer of that ancestor fails.

This is not hypothetical. `custom-set-exists-elsewhere-offers-drill.yaml`
originally created two brand rows under the SHARED `E2E Test Sport <worker>` ›
`2026`, which `util-drill-to-custom-set.yaml` pins 7 flows to. In PR #226 run 1
that took the Manufacturers column from one row (`Topps`) to three and broke
`team-picker-create-custom-card` — a flow with no relationship to it. The fix was
to give the flow its own sport.

**So: if a flow must create a row above SET level, give it a private ancestor.**
A private SPORT is the cheap one — the Sports column is long enough to render a
search input, every drill filters it first, and its list is capped by its own
`max-h-[400px]` scroller, so one more sport row is invisible to everyone.

## Team names (NEO-214)

`teams` is a GLOBAL table with no per-user scoping, and it is **empty at the
start of every run**: the scripted reset wipes it and nothing seeds a shared
fixture back in (NEO-214 deleted the "Seed Test Teams" button and the mutation
behind it, along with the "New York Yankees" / "New York Mets" rows the suite
used to lean on). A flow that needs a team therefore creates its own, and the
same registration rule as sets applies — **pick an unused prefix and add a row
here in the same commit**, so two flows never collide on a name.

Every one of these is created through the product, never seeded: TeamPicker's
`+ New team` row (`id: "New team <typed>"`) opens the **New Team dialog**, whose
`id: "Create team <composed full name>"` button calls `teams.findOrCreate` — on
whichever screen the flow is already standing. `/admin/teams` has no "add a team" control
by design — it edits teams, it does not invent them — so a flow that needs a
team's COLOURS creates the team in a picker first and then colours it there.

**NEO-236 — a team name is now two columns.** `location` ("San Diego") is
optional and `name` ("Padres") is the nickname; the name the product shows
everywhere except the two admin master rows is the two composed. A prefix in
the table below is a NAME, and every flow here leaves Location EMPTY, so the
full name and the short name are the same string and every existing matcher is
unchanged. That is a fixture convenience, not the product rule: Location is
wherever a real team is from — city, state, region or school — and only a name
with no place in it ("Athletics", "Liverpool") is meant to ship blank. **`admin/team-management-edit-a-team.yaml` is the one exception**:
it types `Loc${WORKER_INDEX}` into the Location box, so from the moment it
saves, its team answers to `Loc<w> TMT<token>` (heading, picker option,
chip, `Saved …` line, master-row `aria-label`) while the master row still
PRINTS `TMT<token>`. Any new flow that sets a Location must register it
here the same way, because the composed string is what every other surface
matches on.

That composed string is the ONE place a separator survives, and it is worth
being precise about why it is still safe. `nameNormalized` splits on
whitespace, so `Loc<w> TMT<token>` is indexed as two search terms — "loc\<w\>"
and "tmt\<token\>". The single-token rule protects the step where a flow types
a name **in order to create it** and then reaches for the `+ New team` row,
because a stray suggestion there covers the row and replaces the typed text.
That step still types `TMT<token>` alone; the second term arrives afterwards,
from a Save, and no flow anywhere types a name beginning "Loc", so it is never
queried. The suite's one deliberately multi-term query is the same flow's
full-name lookup at the bottom of the file, which exists to prove the typeahead
finds the composed row: it asserts on the exact composed option id
(`Add Loc<w> TMT<token>`) and never reaches for a create affordance, so a
suggestion cannot satisfy it by accident. Give a second flow a Location, or
type one into a picker before creating, and both arguments lapse — the
Location half would then need a per-attempt token of its own.

### NEO-236 — the review wizard's bulk add is about PLAYERS only

Jason, 2026-09-05: *"add all remaining as new should still process teams, it
should only apply to players."* The footer button is now
**`Add remaining players as new (N)`**, where N counts undecided PLAYERS, and
its sibling is **`Skip remaining names (N)`**, where N counts every undecided
row (skip still rules on teams — a skip creates nothing that could be filed
under the wrong league).

The consequence for flows: **the bulk tap no longer reaches "Confirm & Save" on
its own.** Every team the batch does not already hold — a checklist team name,
or a career team staged off a player's Wikidata history — gets its own
**New Team step** (`New Team: <name>`), because that step asks which LEAGUE and
the bulk path could only ever guess it from the enrichment's suggestion.

Two flows press that button — `setup.yaml` (in its **Base** block only;
NEO-260 deleted the dead Insert and Parallel copies) and
`set-selector/inserts-1996-score-one-nb-set-two-bsc-sources.yaml` — and each
now answers those steps with the same loop.
`set-selector/signed-by-autofills-from-players.yaml` used to be the third; it
pressed the button inside a self-heal fallback that NEO-260 removed (see its
entry under the sole-writer notes):

```yaml
- repeat:
    times: 250
    while:
      notVisible:
        text: ".*Confirm & Save.*"
    commands:
      - runFlow:
          when:
            visible:
              id: "Add as New (Team|League)"
          commands:
            - tapOn:
                id: "Add as New (Team|League)"
```

> ⚠️ **ONE probe, keyed on the step's BUTTON — never one per step heading.**
> A `when: visible` that resolves FALSE pays a full settle; one that resolves
> TRUE costs a fraction of a second. Measured on the same loop, same flow, two
> CI runs: with a single `New Team: .*` probe that was true every iteration the
> loop cost **80.8s** (22 iterations, 7.6s of probing); adding a second
> `New League: .*` probe that was false in 23 of 29 iterations took it to
> **294.9s** — **+214s, of which +192s was probe overhead** and only 11.5s was
> the six league taps it existed to do. That regression alone pushed
> `inserts-1996-score…` from 386s past the runner's 600s `FLOW_TIMEOUT_SEC`.
> Key on something PRESENT whenever there is work, and the loop stays cheap.
>
> **`(Team|League)`, never `(Player|Team|League)`.** The id is a regex over the
> button's accessible name. A player row the bulk left undecided is an
> ambiguous same-name row — two NB players already carry that name and the
> wizard is asking which is on the card. `Add as New Player` there mints a
> third one silently, the exact failure NEO-254 exists to remove. Left out of
> the matcher, the loop runs out and the wait after it fails loudly instead.

> ⚠️ **`times`, never `maxRuns`.** This snippet used to be written with
> `maxRuns:`, which is not in `YamlRepeatCommand` at all — an unknown property
> is a HARD parse error that kills the whole flow before command one, and that
> is precisely how the seed job once died with
> `Unknown Property: maxRuns at …/setup.yaml`. The schema is `times` (the
> runaway guard) and `while` (the intent), and they combine.

One tap per step, accepting the Location, Name and League the step already
shows — what an operator who agrees with the pre-fill would do. Keyed on the
TERMINAL state (`Confirm & Save` not yet visible) rather than on a step being
visible, because players and their staged teams drain at the same time and a
loop keyed on `New Team:` exits the first time it catches the batch between
lookups. `times` is a runaway guard; the `extendedWaitUntil` on
`Confirm & Save` after the loop is still the real gate.

> **It is `times`, not `maxRuns`.** This snippet published `maxRuns: 250`
> until NEO-260. `maxRuns` is not in Maestro's `YamlRepeatCommand` schema — it
> was invented — and an unknown property is a **hard parse error that kills the
> entire flow before a single command runs**, with a message pointing at a line
> nobody just edited. That is exactly how it took the seed job down once.
> Anyone who copy-pasted this block reproduced the outage the registry
> elsewhere describes. See the comment at `flows/setup.yaml`'s own loop.

### NEO-254 — a New LEAGUE step, and why no flow covers it on its own

The bulk mints no league either (`decideAllRemaining` returns early on any
`row.kind !== "player"`), so a team whose enrichment names a league NB does not
have gets a **`New League: <name>`** step staged AHEAD of it, and later teams
pick the staged one. Its footer is `Add as New League`, `Skip — no league` (not
"not a league" — the string IS a league; skipping says this TEAM has none) and
`Link to Existing…`; its form is `New league name` (pre-filled), plus
abbreviation, level, years, aliases and a Wikidata id.

**There is no dedicated flow asserting that step, deliberately.** It is not
reachable cheaply:

* The wizard only opens off a REAL fetch, and a league step needs a team whose
  live enrichment names a league NB is missing. Nothing about that is
  deterministic — whether it appears depends on what Wikidata returns for
  whichever names settle first, and on which leagues earlier flows have already
  created in the same shared deployment.
* It is also self-erasing: the seed's Base sync now answers league steps, so by
  the time any later flow runs, the obvious leagues (MLB and friends) exist and
  no step is staged for them. A flow asserting "a league step renders" would
  pass on a cold preview and quietly stop exercising anything on a warm one —
  the worst kind of green.
* Reaching one on demand would mean a NEW real marketplace-backed set chosen
  for the leagues it surfaces, which is a 30–90s sync and needs owner sign-off
  every time (see **Adding a set**).

So the step is covered where it is deterministic: `NewLeagueForm.test.tsx`,
`entityReviewQueue.leagueStaging.test.ts` and `EntityReviewWizard.test.tsx`
pin the form, the staging order and the decision. What the three E2E flows owe
it is only that they ANSWER it — which is the loop above, and which is enough,
because a league step they cannot answer stops the batch dead and fails them.

**Do not answer these with a seed.** `e2e-baseline.sh` says it outright —
NEO-214 removed the seed-teams fixture — and the standing rule is that E2E
fixtures come from the UI. Creating a real set's worth of teams through Team
Management first would cost far more wall-clock and would exercise the wrong
screen.

Two consequences worth knowing before writing a picker step:

* The typeahead matches and de-duplicates on the COMPOSED name, so typing a
  full name finds a split row and suppresses the create row. Reach for
  `id: "Add <full name>"`, not `id: "New team <full name>"`, once a row with
  that composed name exists.
* **Creating a team is TWO steps now (NEO-236).** The popover holds ONE create
  affordance — a row reading `+ New team "<typed>"…`, accessible name
  `New team <typed>` — and taking it OPENS a portalled dialog. The dialog is
  headed `New team: <typed>` and asks the three questions a `teams` row needs:
  `New team location (optional)`, `New team name` (pre-filled with the typed
  text) and a `New team league` radiogroup of pills (the sport's leagues, an
  optional `Create <league>`, and `No league`), with a `Shows as:` preview. Its
  Create button keeps the accessible name every flow already used —
  `Create team <composed full name>` — so the only change to an existing flow is
  the extra step that opens the dialog.
  * A flow that leaves Location blank and picks no League composes to exactly
    the typed name, which is why every matcher below is unchanged.
  * **Tap the dialog's Create button by `id`, never a second `pressKey: Enter`.**
    Create and Cancel are `NeonButton`s with an identical class string, and
    maestro-web re-finds the focused element by an XPath that falls back to that
    class — an Enter aimed at Create can land on Cancel.
  * The dialog is portalled to `document.body` at `z-[60]` and centred, so no
    scrolling ancestor can clip it. The POPOVER ROW still can: where the picker
    sits inside a short scroll box (the attention walker's `max-h-[70vh]` body,
    the bottom of the Players page's career editor), open the dialog with
    `pressKey: Enter` on the search input — guarded by
    `assertVisible: "No matches."` — instead of tapping the row.

Every name in this table is `<Prefix>${output.ATTEMPT_TOKEN}` — one
alphanumeric search token, no hyphen, underscore or space anywhere in it
(NEO-260). The token is derived once per flow, right after the launch gate:

```yaml
- evalScript: '${output.ATTEMPT_TOKEN = String(ATTEMPT_ID || Date.now()).split("-").join("")}'
```

`ATTEMPT_ID` is `<worker>-a<attempt>-<random>` — CI's `run-e2e-queue.sh` spells
the worker half `r<n>`, the local `run-e2e-smoke.sh` spells it `w<n>` — so
stripping its hyphens gives a token that is both per-attempt and per-worker: the
readability the old `${WORKER_INDEX}` prefix bought is folded INTO the token
rather than separated out by another hyphen. Strip the hyphens and use the
whole thing; never assume which letter the worker half starts with.

| Prefix | Owning flow | Notes |
|---|---|---|
| `CNAA`, `CNAB` | `checklist-attention-badge-and-filter.yaml` | two teams; CNAB is the born-linked card's alone, which is what makes its row assertion single-row |
| `CNWT` | `checklist-attention-walker-missing-team.yaml` | |
| `NBTeam` | `team-picker-create-custom-card.yaml` | created under `E2E Test Sport <w>`, not Baseball |
| `NBPlayer` | `player-picker-create-custom-card.yaml` | a PLAYER, not a team — `players.search` tokenises identically, and the row persists the same way |
| `PM` | `admin/player-management-add-and-career-history.yaml` | the PLAYER this flow adds by hand; `PMT` below is the team it gives him. The two diverge at their THIRD character, so neither name is a prefix of the other and neither picker can be answered by the other's row |
| `PMT` | `admin/player-management-add-and-career-history.yaml` | |
| `SLP` | `spine-label/player-team-colors-default-to-longest-tenure.yaml` | the PLAYER; `SLA`/`SLB` are his two teams. This is the one flow that types a strict PREFIX of a minted name — see the prefix note below |
| `SLA`, `SLB` | `spine-label/player-team-colors-default-to-longest-tenure.yaml` | coloured `#132448` / `#002d72` |
| `TLF` | `checklist-title-length-limits-and-fixer.yaml` | kept SHORT on purpose: the name lands in a generated listing title measured against an 80-character cap. `TLF<token>` is 8-12 chars, 3 fewer than the `TLF-${ATTEMPT_ID}` it replaced and 4-8 fewer than the "New York Yankees" before that — the rename spends less of the budget, never more. Read the FIXTURE SIZING block in the flow before changing any name in it |
| `TME` | `admin/team-management-edit-a-team.yaml` | the throwaway PLAYER that flow creates on the way in, because a career editor is the only place outside the set-builder cascade where a team can be born. `TMT` below is the team it makes there; the two diverge at their third character |
| `TMT` | `admin/team-management-edit-a-team.yaml` | the ONLY team in the suite with a `location` (`Loc${WORKER_INDEX}`), so once it saves its composed name is `Loc<w> TMT<token>` — see the composed-name note above for why the extra term is inert |
| `MintedTeam` | `checklist-wizard-career-team-commits.yaml` | |
| `TPT` | `team-picker.yaml` | |
| `ProbeTeam` / `TempTeam` | `checklist-wizard-career-team-entry.yaml` | never persisted — the flow discards its batch |

### ⚠️ A name typed into a team picker must be a SINGLE search token

`teams.search` is a Convex SEARCH index: it matches on TOKENS split at
non-alphanumerics, not on substrings. So `CareerTeam-<attempt>` tokenizes to
["CareerTeam", "<attempt>"] and matches **any** persisted team sharing the
leading word — the per-attempt suffix buys nothing.

That is how CI run 34050688656 broke two flows at once. The committing
career-team flow persisted `CareerTeam-4180`; the read-only sibling then typed
`CareerTeam-9351`, the suggestion list offered 4180, its dropdown covered
"+ Add", and the tap landed on the suggestion — which REPLACED the typed name.
Renaming only the writer is NOT enough: reproduced locally, typing
`CareerTeam-w7a26340` with `CareerTeam-4180` still in the table failed
identically.

**The rule: every minted team or player name is separator-free**
(`MintedTeam<token>`, `TPT<token>`, `NBPlayer<token>`), so it is one token
nothing else can share. **This holds without exception, for every name in the
table above.**

The exception this section used to grant — that `TMT-`/`PMT-`/`SLA-`/`CNAA-`/
`TPT-`/`NBTeam-`/`TLF-` could keep their hyphens because "each is created and
consumed inside one flow that also removes it" — was simply **false**, and
NEO-260 retired both the claim and the names. **Nothing removes them.** There is
no delete-team (or delete-player) affordance anywhere in the product: the only
deletes in the codebase are the armed internal reset batches
(`selectorOptions:resetTeamsBatch` / `resetLeaguesBatch`, reachable only through
`e2e-baseline.sh reset`) and `entityReviewQueue:cancelBatch`, which by its own
contract touches only review-queue rows and never `teams`, `players` or
`cardChecklist`. The TeamPicker's `Remove team <name>` control **unlinks** a team
from a card; the row it points at is untouched.

So every team a flow creates stands for the **whole run**, on the one Convex
preview a pool of concurrent runners is draining a shared queue against. A name
another flow could type is therefore visible to that flow the moment it exists —
which is exactly what run 34050688656 was, two flows in the SAME run. (The
`seed` job's scripted reset does wipe `teams` at the START of each run, so the
rows do not survive from one run into the next; that is the only thing that ever
clears them, and it is no help at all against the run they were created in.)

**And derive the token from `${ATTEMPT_ID}`, not `output.ATTEMPT_ID`.** The
runner injects it with `-e ATTEMPT_ID=…`, which Maestro exposes as the binding
`${ATTEMPT_ID}`; it never populates `output.ATTEMPT_ID`. The older idiom
`output.ATTEMPT_ID || String(Date.now()).slice(-4)` therefore ALWAYS fell
through to a 4-digit value that recycles every ten seconds, so two runners
collided constantly. Correct form:

```yaml
- evalScript: '${output.ATTEMPT_TOKEN = String(ATTEMPT_ID || Date.now()).split("-").join("")}'
```

**Always per-ATTEMPT, not just per-worker.** `+ New team <name>` is offered only
while no team of that name exists, so a name a previous attempt left behind
renders `Add <name>` instead and the create step reaches for a control that is
not there. (`ATTEMPT_ID` carries the worker half before its first hyphen, so
stripping the hyphens keeps the worker inside the token — which is why no name
needs a separate `${WORKER_INDEX}` prefix any more.)

**Players follow the same rule** — `players` is global, equally empty, and
`players.search` is the same kind of index. Every minted player name in the
suite is separator-free and registered in the table above: `NBPlayer`
(`player-picker-create-custom-card.yaml`), `PM`
(`admin/player-management-add-and-career-history.yaml`), `SLP`
(`spine-label/player-team-colors-default-to-longest-tenure.yaml`) and the
throwaway `TME` that `team-management-edit-a-team.yaml` needs in order to reach
a career editor at all. There is no exception left, and no new one is coming: a
new player name is `<Prefix>${output.ATTEMPT_TOKEN}` like every team name.

**Typing a PREFIX of a minted name is still allowed — and it is still one
token.** One step in the suite does it deliberately: the spine designer's player
search in `player-team-colors-default-to-longest-tenure.yaml` types the bare
`SLP` and then taps the full `SLP<token>`, because maestro-web reports an
input's value as its text, so a full-name query would make the search box answer
to the same string as the option under it and the tap could land on the box. A
prefix of a single token still searches: Convex prefix-matches a query's LAST
term, which in a one-token query is the whole query. Two things bound how much
of the name a prefix may assume. It must be a prefix under BOTH runners —
`run-e2e-queue.sh` builds `ATTEMPT_ID` as `r<n>-a<attempt>-<random>` while
`run-e2e-smoke.sh` builds `w<n>-a<attempt>-<random>`, so nothing past the flow's
own literal prefix is portable — and whatever it narrows to must be confirmed by
a FULL-name assertion straight afterwards, because a prefix on its own no longer
identifies the attempt.

## Read-only consumers of the shared real set

These flows drill to 2024 Topps Chrome and do not write its **cards, players,
teams or variants**. They are the reason the set must stay pristine.

- `base-mapping-cancel-recovers.yaml`
- `checklist-bsc-team-enrichment.yaml`
- `checklist-renders-rich-fields.yaml`
- `multi-source-panel-opens-dialog.yaml`
- `sets-base.yaml`
- `sets-resync-already-loaded.yaml`
- `topps-chrome-marketplace-read.yaml`

**Two flows on this set are NOT read-only, and the list used to say they were**
(corrected NEO-260). Each is **sole writer of one datum on the anchor** —
approved by Jason, 2026-09-09 — and neither touches the checklist itself:

| Flow | What it writes | Tolerance |
|---|---|---|
| `signed-by-autofills-from-players.yaml` | `autographed` / `signedBy` on card **#300** | sole writer of those two fields; no other flow reads or writes them |
| `topps-chrome-add-feature.yaml` | toggles one feature on the anchor, twice per run | sole writer of that feature; returns it to its starting state |

**`signed-by-autofills-from-players.yaml` no longer self-heals an empty Base
checklist (NEO-260).** It used to carry a `when:`-guarded fallback that fetched
and COMMITTED the entire shared Base checklist when it found the set empty —
a write to a registered shared set by a flow entitled to two card fields and
nothing else, and one that converted a failed seed into a green run proving
nothing. `flows/setup.yaml` is the flow's documented precondition. The fallback
is now a single positive assertion that the checklist has cards, so an unseeded
run fails loudly instead of rebuilding a fixture the rest of the queue is
reading. **Do not re-add a self-heal branch to any consumer of this set: the fix
for an empty shared set is to fix the seed.**

## Adding a set

**Custom set** — pick an unused prefix, add a row to the table above in the same
commit, and drill with `util-drill-to-custom.yaml`:

```yaml
- runFlow:
    file: util-drill-to-custom.yaml
    env:
      SPORT: "Baseball"
      YEAR: "2024"
      MANUFACTURER: "Topps"
      SET_NAME: "myprefix-${WORKER_INDEX || 0}"
      VARIANT_TYPE: "Insert"
      VARIANT: "Base"
```

**Real set** — stop and ask the owner first. If approved: extend
`flows/setup.yaml`'s provisioning and its CANONICAL PRE-SYNCED DATA block, add a
row to the real-set table above, and state the measured sync cost in the PR.
