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

### While SportLots is on pause (NEO-287) every real set is BSC-ONLY

The operator switch `NEONBINDER_PAUSED_PLATFORMS=sportlots` (mirrored to the
flows as `-e PAUSED_PLATFORMS`; README → "Operator switches") means nothing is
asked of SportLots, so every row in this table is provisioned from
BuySportsCards alone for the whole run:

* **2024 Topps Chrome** — `Base` (335 cards), `Insert` → Future Stars,
  `Parallel` → Gold Wave Refractors, all fetched on the NEO-255
  one-marketplace path: every BSC card kept, no `Match Cards` dialog, every
  row a solo-kept "BSC only" card with no `SL` badge and no SportLots id
  anywhere in the chain. The Base is confirmed **BSC-only** in the picker by
  the seed. Because `baseHasMapping` counts the SportLots slot only, such a
  Base still reads as unmapped: every later drill auto-opens the picker
  again, and `util-drill-to-base-variant` leaves it the no-write way
  (Cancel → Close → "Map Base Set") on every read-only set.
* **Manufacturer rows are hand-made.** NeonBinder's Manufacturer rows come
  from SportLots' brand list and nowhere else (`convex/platformLevels.ts`), so
  under the pause the Manufacturers column syncs to nothing and the row is
  added through the column's own "+ Custom" form by the path's **sole
  writer**: `Topps` under Baseball → 2024 by `setup.yaml`; `Score` under
  Baseball → 1996 by `inserts-1996-score-…` (via `CREATE_MANUFACTURER: "1"`
  on the drill); `Topps` under Hockey → 2024 by `set-rename-…` (via
  `util-drill-to-cold-real-set`, which adds a ROW under the pause), and
  `SPx` under Hockey → 1997 by `brand-via-all-brands-…` (its own "+ Custom"
  step — the flow's feature). A hand-made row carries no ids and is a row
  like any other (invariant 6); `syncSetsAcrossManufacturers` files BSC's
  sets under it by its set-name prefix (`metadata.setNamePrefix`, defaulted
  to the name at creation — NEO-237), and when the pause lifts the next
  manufacturer sync matches SportLots' own row to it by name and attaches
  the id — no second row.
* **"All Brands" is a VIEW, not a row (NEO-237).** It is pinned to the top
  of every Manufacturers column in both modes and never created, synced or
  typed: `checklist-one-marketplace-…` reaches Hockey → 1995's one-sided set
  through it (`MANUFACTURER: "All Brands"` on the cold util, which taps the
  pinned entry), and the row that holds the sets no brand claims is the
  year's **`Unknown`** row, minted by the year-wide Sets sync (BSC phase)
  under the pause, or by the manufacturer sync live, when it routes
  SportLots' own "All Brands" option onto it. Since 2026-09-21 that row is
  listed FIRST among the column's data rows, directly under the view,
  rather than alphabetically among the brands; no flow reads the column by
  position (every row tap is an exact name under the header or the search
  box), so nothing in the suite depends on either order. Typing "All Brands"
  into "+ Custom" is refused.
* Everything that says "MAPPED on BOTH sides" below is mapped on the BSC side
  only under the pause, and every `SL only` / `SportLots only` expectation is
  vacuous. Flows branch on `output.SL_PAUSED`, never on the screen (R10).
* **Below the root the tree looks BSC-only, not paused** (README → "Operator
  switches"): `Baseball` carries no SportLots id, so every lower level skips
  SportLots for want of ids — Years says "SportLots skipped: no SportLots ids
  on this path.", Manufacturers holds only the pinned All Brands view entry
  over its idle empty text, the base picker's SportLots pane reads
  "SportLots returned no base set for <set>". Only the root Sports notice
  carries the paused sentence. A brand's Sets column (a hand-made brand, or
  any brand under the pause) ends "done" with "SportLots skipped: no
  SportLots ids on this path." since NEO-237 made Sync Sets two-sided — a
  notice, not a failure; the seed's strict asserts key on failure copy only.

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
| Hockey → 1995 → Unknown (reached through the All Brands view) → Roanoke Express ECHL | `Base` — 25 cards, fetched and COMMITTED in-flow, BSC only (NOT pre-synced) | `flows/set-selector/checklist-one-marketplace-skips-match-dialog.yaml` — **sole writer**. ✅ **APPROVED 2026-09-09** (NEO-260); manufacturer row renamed by NEO-237 (the marketplace's "All Brands" option is routed onto the year's `Unknown` row, never stored under its label) |
| Hockey → 1997 (the whole year) | a manufacturer row `SPx` linked through SportLots' All Brands option; the per-brand SportLots reviews the year-wide Sync Sets leaves behind (NEO-306: SportLots-only names are no longer saved as sets; the reviews stay unsaved, labels never read or asserted); the year's BSC sets filed under the brands / `Unknown` and the prefix-matching ones re-homed to `SPx`. No checklist is fetched. | `flows/set-selector/brand-via-all-brands-narrows-sportlots.yaml` — **sole writer** of the year. ✅ Claimed by Jason 2026-09-21 (NEO-237 §0.1); the prefix `SPx` **measured** on PR #272's preview 2026-09-21 — see the Hockey 1997 section |
| Baseball → 2024 → Topps → Topps MLB at Rickwood Field Negro Leagues Collection | `Base` — 4 cards, BSC only (the SportLots picker is CANCELLED in-flow; SportLots does not carry the set), fetched and COMMITTED in-flow (NOT pre-synced) | `flows/set-selector/checklist-wizard-link-team-saves-alias.yaml` — **sole writer**. Approved by Jason 2026-09-16 (NEO-284) |
| Baseball → 2026 → Bowman (the whole brand-year) | the brand's SportLots review SAVED in-flow (NEO-306): the set `Bowman All-America` (+ Base), `All-America Game Autos` under Bowman › `Insert`, every other SportLots-only name under Bowman › `Parallel`; Bowman › `Insert` reconciled (NOT pre-synced) and grouped — the BSC insert `Anime Kanji` promoted to a parallel of `Anime`, re-synced, its checklist fetched and COMMITTED; Bowman › `Parallel` re-synced and saved (BSC's `Blue` paired with the filed row); `Blue`'s SportLots link promoted to `Bowman Blue` and folded back; the Parallel row `All-America Game Autos Red Ink` moved under Bowman › Insert › `All-America Game Autos` as the parallel `Red Ink` | `flows/set-selector/flagship-colour-is-a-parallel-both-ways.yaml` — **sole writer** of the brand-year. Requested by the owner 2026-09-21 (NEO-293); one ordered flow by owner decision 2026-09-25 (NEO-306), merging `parallel-grouping-promoted-insert-fetches-from-bsc` into it |
| Baseball → 1990 (the whole year) | Every brand row NB's known-brands list mints for the year, the year's `Unknown` row, and every BSC set of the year filed under one of them; one set (expected `CMC…`) is MOVED to `Unknown` by the operator control and left there. No checklist is fetched, no Base is mapped, nothing is renamed or deleted, and NO row is added to Baseball's shared Years column (1990 is synced, and the drill selects it). | `flows/set-selector/known-brand-files-set-and-operator-move-sticks.yaml` — **sole writer** of the year. ✅ Claimed by Jason 2026-09-22 (NEO-294); see the Baseball 1990 section |

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

### 2026 Bowman — ONE sole writer, the whole brand-year (NEO-293, NEO-300, NEO-305, NEO-306)

`flows/set-selector/flagship-colour-is-a-parallel-both-ways.yaml` is the only
flow on Baseball → 2026 → Bowman. It proves, in order, where each
marketplace "set" of the brand belongs in NB and that the operator can move
rows across that line with their links intact:

1. Sync Sets mints no SportLots-only set; the brand's review (the pill `N
   SportLots sets to sort`) files them — every row under Bowman › Parallel in
   bulk, `All-America` as its own set, `All-America Game Autos` under Bowman ›
   Insert (NEO-306).
2. Bowman › Insert — populated by the review, so an explicit `Sync Inserts` —
   reconciles BSC's inserts with SportLots'; `Anime` and its parallels become
   NB sets ("Make its own set", "Keep all"); Group Parallels nests `Anime
   Kanji` under `Anime`; a second `Sync Inserts` leaves the grouped rows alone
   (NEO-293, NEO-300).
3. The promoted `Anime Kanji` keeps its BSC id as a working source: a chip
   tagged as a BSC variant, no "Needs re-mapping", Fetch from Marketplaces
   saves cards, and the chip's per-slot count is > 0 (NEO-293).
4. Bowman › Parallel's sync pairs BSC's `Blue` with the review's `Blue`;
   `Promote to set` and `Make parallel of…` move that link out and back
   (NEO-305).
5. `Make insert of…` moves the review's Parallel row `All-America Game Autos
   Red Ink` under Bowman › Insert › `All-America Game Autos` as the new
   parallel `Red Ink` (NEO-306).

**Why one flow (owner decision, 2026-09-25).** It was two:
`parallel-grouping-promoted-insert-fetches-from-bsc` (NEO-293/300, Bowman ›
Insert) and this one. They could not share a preview in either order: an
insert column auto-syncs only when EMPTY, so whichever flow wrote Bowman ›
Insert first stopped the other's first reconcile from ever opening, and the
CI queue orders nothing. They were merged with every assertion of both kept.

**Why this set.** Every claim needs what the marketplaces ANSWER: a REAL BSC
insert whose REAL BSC parallel word-prefixes it (so Group Parallels suggests
the nesting — maestro-web cannot drive the modal's drag), a brand whose
flagship BSC lists AND whose colours SportLots lists as sets, and SportLots
names that belong under an insert. Observed on production by the owner,
2026-09-21/24: BSC lists the sets Bowman, Bowman Chrome, Bowman Sapphire
Edition; under Bowman › Insert, `Anime` and its parallels `Anime Kanji`,
`Anime Black Refractors`, `Anime Red Refractors`, `Anime SuperFractors` as
insert-level variantNames; SportLots carries `Chrome Anime Kanji` (id 378117)
among ~479 sets for the year, plus the colours and the All-America products.
The alternative — nesting BSC-synced rows under a hand-made parent on 1996
Score — was rejected by the owner: a hand-made row must never anchor
marketplace data, and the harness must never dictate the data shape.

| | |
| -- | -- |
| drills | Baseball → 2026 → Bowman, every level COLD on a fresh preview; under the pause the manufacturer row `Bowman` is hand-made by the drill (`CREATE_MANUFACTURER`), exactly as `Score` is for 1996 |
| review (live) | bulk: every row → Bowman › `Parallel` (picking Bowman force-syncs its Variant Types inside the dialog, additive); per row: `All-America` → its own set; row tick + bulk: `All-America Game Autos` → Bowman › `Insert`; saved at the 7000 bar |
| Insert reconcile (live) | `Sync Inserts` (the column holds the review's row); filters Ready and BSC to "Anime"; `Anime` its own set when Pending; "Keep all" on the "Anime"-filtered BSC column; **saves every Ready set** (the review's row comes back restored) |
| grouping | Group Parallels → Accept all suggestions → Save; every prefix pair nests, `Anime Kanji` and the other Anime parallels under `Anime` |
| re-sync (NEO-300) | "Sync Inserts" again; live the reconcile re-opens and is saved with no edits, paused the single-platform store runs; both say "N already grouped as parallels. Leaving those be." and do not re-create a grouped row as an insert |
| fetch | on the promoted `Anime Kanji`: the pairing dialog when SportLots paired a set with it, the one-marketplace path otherwise; the review is drained with "Skip remaining names" (no players created) |
| Parallel reconcile (live) | `Sync Parallels` (the column holds the review's rows); BSC's `Blue` lands on the review's restored `Blue` row (attached by id, the NEO-306 reconcile fix); every Ready set saved |
| promote / fold | `Blue`'s SportLots link → the set `Bowman Blue` (the row stays: BSC holds it) → `Make parallel of…` folds it back onto `Blue` |
| make insert | Bowman › Parallel › `All-America Game Autos Red Ink` → Bowman › Insert › `All-America Game Autos` › new parallel `Red Ink` (the dialog's `Find an insert` filter used when the list is over 12) |
| paused | no review, no pill; Insert and Parallel fill from BSC alone; grouping, re-sync, chip and one-marketplace fetch as live; `Blue` offers no Promote, and the SportLots-only claims have no paused form |

**What the flow leaves behind** (fresh-only; `setup.yaml`'s reset removes it
all at the head of every run):

| | |
| -- | -- |
| sets | `Bowman All-America` (+ Base holding its SportLots id); no `Bowman Blue` |
| Insert | every set the Insert reconcile saved, with the ids the sync gave it; every word-prefix pair nested by Accept All (`Anime Kanji` a parallel under `Anime`, its BSC slot tagged `variantName`); `All-America Game Autos` with the parallel `Red Ink` |
| Parallel | every SportLots-only colour the review filed, plus BSC's parallels; `Blue` with BSC + SportLots links |
| `Anime Kanji` checklist | COMMITTED, every card from BSC (plus SportLots' when paired); its unknown names SKIPPED, so no players or teams are minted |
| never touched | Base, any other checklist, any card edit |

**Sole writer, fresh-only.** No other flow may drill into 2026 Bowman. A
re-run against the same deployment finds the review saved and fails on the
pill by name.

**⚠️ MEASURE on the first preview run** (STEP 0 constants; each wrong guess
fails the step that reads it, by name). Record the readings here:

* the review's brand-stripped labels: `All-America` (→ the set `Bowman
  All-America`), `All-America Game Autos` (must start with `All-America`),
  `All-America Game Autos Red Ink`;
* Bowman's variant-type names as the BSC sync writes them: expected `Base` /
  `Insert` / `Parallel`;
* the review's size (the pill's N), and the save against the 7000 bar — a
  miss is a product finding (Jason, 2026-09-25), not a bigger number;
* the in-dialog Variant Types sync against its 60000 marketplace ceiling;
* whether BSC lists an insert that word-prefixes `All-America Game Autos`
  (Accept All would nest it, and STEP 14's `Add to …` would be gone) or an
  `All-America Game Autos Red Ink` parallel on either side (the source would
  gain a BSC link and Make insert of… would not be offered);
* the Make insert of… toast path (`“…” now lives at Bowman › Insert ›
  All-America Game Autos › Red Ink.`) and whether "Where it goes" crossed 12
  choices (the flow uses the filter when it did).

`ensureSelectorOptions` has no "already syncing" guard; with one flow on the
brand-year nothing races it any more.

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
| `checklist-wizard-link-team-saves-alias` | Topps MLB at Rickwood Field Negro Leagues Collection (NEO-284, one-sided — see its own section) |

See "The three COMMITTING entity-review fixtures" below, and "The TEAM-link
alias fixture" after the one-marketplace section.

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

### The ONE-MARKETPLACE fixture — Hockey / 1995 / Unknown (via the All Brands view) / Roanoke Express ECHL (NEO-255) ✅ APPROVED

> **NEO-237 (2026-09-21) renamed the manufacturer row and changed how the
> flow reaches it.** "All Brands" is now a VIEW pinned to the top of the
> Manufacturers column, not a row; SportLots' no-filter option of that name
> is routed by the manufacturer sync onto the year's brand-unknown row, which
> NB mints as **`Unknown`** (`ensureBrandUnknownRow`) and never names after
> the marketplace's label. The flow drills the pinned view
> (`MANUFACTURER: "All Brands"` on `util-drill-to-cold-real-set`, which taps
> the entry in both modes and creates nothing), picks the set from the
> year-wide list, and asserts the collapsed Manufacturers card reads
> `Unknown` — the live proof of the routing, the year-wide filing and the
> view's back-fill. STEP 8's title negative now covers both spellings
> (`Unknown` and `All Brands`). The text below is the 2026-09-07 measurement
> record and still describes the DATA; read "All Brands" in it as "the row
> now called Unknown" wherever it means the manufacturer row, and as the
> view where it means what the flow taps.

> **Approved by Jason, 2026-09-09 (NEO-260).** This section previously said the
> flow would keep its `wip` tag until approval landed. It never carried one —
> nothing excluded it and it had been running on every PR regardless, which is
> how the gap was found. The `wip` note and the NEO-258 stall rationale are both
> stale and are struck; the flow runs in the full suite like any other.

**What was asked for:** one new real set —
**Hockey → 1995 → All Brands (now `Unknown`) → Roanoke Express ECHL**, `Base` — touched by
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
| ancestors | `Hockey → 1995 → Unknown` (reached through the All Brands view; the row was called All Brands before NEO-237) |
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

#### What STEP 8 writes, and why it has to write anything (NEO-272)

The flow ends by opening a card's detail drawer and asserting that the server's
generated `listingTitle` carries the set name and NOT `All Brands` — the live
half of NEO-272, and the only place in the suite where the sync's legacy
adoption of a marketplace-supplied brand-unknown row is exercised.

It cannot read that title off one of the 25 committed cards. **Every card in
this set is numbered `NNO`** (measurement 3's checklist), so all 25 rows offer
an identically-named `Edit card NNO` control, and `CardChecklist`'s Virtuoso
list renders ~3 rows above its own scroll viewport whose bounds are real and
whose pixels are clipped (`increaseViewportBy={{top: 200, bottom: 400}}`). CI
run 34556066366 tapped the first of those at (687,233) — the `Cards (25)`
header — and the drawer never opened. NEO-272 made the labels distinguishable
("Edit card NNO, Jon Larson"), which fixes the screen-reader half, but the card
NAMES here are the marketplace's and unknowable to a flow.

So STEP 8 hand-adds **one** card, `NB272-${ATTEMPT_ID}`, with no card name (the
server defaults it to `Card #NB272-<attempt>`), and reads the title off that.
`addCustomCard` writes `generateListingTitle` at creation and composes it
through `findAncestorLabels`, which reads `metadata.isBrandUnknown` off the very
manufacturer row STEP 1's sync had to stamp. The added row carries no
marketplace ids, nothing attaches any to it, and it lands after every count
assertion in the flow, so `Kept all 25`, `All reviewed — save 25`,
`Saved 25 cards` and `Cards (25)` are all already banked. This flow is the set's
sole writer (table above), and the set is single-use per preview deployment —
the same reason STEP 4 can assert an empty checklist.

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

`syncSetsAcrossManufacturers`' BSC phase files every BSC set whose name
prefix-matches no brand's `setNamePrefix` under the year's brand-unknown row
(`Unknown`; "All Brands" before NEO-237) — the minor-league, junior, college
and team sets. Those sets get a BSC id and no SportLots id, at any level a
SportLots attachment can live on, which is what makes them one-sided. The
SportLots phase NEO-237 added SAVES the sets SportLots lists that NB has no
row for (since 2026-09-21; a review modal stood in between before) — but only
as NEW `setName` rows with their own Base: `routeSlSets` hides every entry
that an existing set EQUALS or word-boundary-PREFIXES, and no path attaches a
SportLots id to a row BSC filed. So the phase adds rows beside this set under
`Unknown` and cannot make this set itself two-sided; the flow reaches it by
its exact name through the search box, so the extra rows do not change what
it taps. (See item 4 above for what is NOT true of the row.)

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

#### It also carries NEO-272's only live assertion (STEP 8)

The flow's last four commands open ONE committed card's detail drawer and assert
that the drawer's `Card title` names the set and **not** `All Brands`. That is a
second feature riding this fixture, documented as such in the flow's header, and
it is here because this is the suite's only subtree under a manufacturer row
whose brand NB has not identified — a flow of its own would need a second real
set and another owner approval for a claim this one is standing three lines away
from.

`All Brands` is not a brand: it is the marketplace's no-filter option on its
brand axis ("show all cards from all brands"), carried as a manufacturer row, and
the sets under it are the ones whose brand NB has not identified. Its name says
nothing about any card beneath it, so composing it into a buyer-facing listing
title is meaningless text — which is what STEP 8 pins.

Why the fixture is the right one, beyond convenience (updated for NEO-237):
SportLots' own brand list for Hockey 1995 carries its "All Brands" option
(measurement 2 above), and the manufacturer sync now ROUTES that option onto
the year's brand-unknown row — minted as `Unknown` with the flag set in the
same transaction (`ensureBrandUnknownRow`), the option's id attached, its
label never stored. The old *legacy adoption* branch is gone. What a live
run proves that `convex-test` cannot is the chain on real data: SportLots
really lists the option, the real adapter returns it, the sync routes it,
the year-wide Sets sync files this set under that row (STEP 2's `Unknown`
card), and the title generator drops the row (STEP 8). Every CI run of this
flow runs that chain cold.

It is **read-only**: nothing is typed, the drawer's fields commit only on Enter
or a changed blur, and `previewListingTitle` stays `"skip"` until Regenerate is
pressed, so the drawer costs no server round-trip. **Estimated at ~7-9s and not
yet measured** — no preview existed when it was written. First green run that
records a real title on this set should tighten STEP 8's positive assertion into
one anchored shape and note what it measured.

Note for a fixture swap: STEP 8's negatives name the literals `Unknown` (what
NB mints the brand-unknown row as, on every year) and `All Brands` (the
marketplace option's label, which must never be stored as a row name). STEP 1
hard-codes `All Brands` as the util's cue for the pinned VIEW, and STEP 2
asserts the collapsed card reads `Unknown`. A year whose brand-unknown row is
somehow named differently breaks STEP 2 first, loudly, so the three cannot
silently disagree — but they must be changed together.

#### Spares, if the set ever has to be swapped

Same shape, same ancestors, all verified present in the 134-set column and all
regex-safe: `Dayton Bombers ECHL` (**32 cards — already committed on PR #242's
preview by the pilot probe, so it is spent there**), `Dunkin Donuts Portland
Pirates AHL`, `Tulsa Oilers CHL`, `Memphis RiverKings CHL`,
`San Antonio Iguanas CHL`, `Fort Worth Fire CHL`, `Halifax Mooseheads QMJHL`.
Swapping is a one-line edit to `output.SET` in the flow's STEP 0 plus the two
name literals in this section. Avoid names carrying regex metacharacters or a
`/` (`Electrolarm/Z-104 …`, `Kellogg´s …`).

### Hockey → 1997 — the via-All-Brands brand fixture (NEO-237) ✅ CLAIMED by Jason 2026-09-21

**What was asked for (plan §0.1, answered "yes, Hockey 1997 claimed"):** one
real YEAR — **Hockey → 1997** — owned end to end by exactly one flow,
`flows/set-selector/brand-via-all-brands-narrows-sportlots.yaml`, which proves
on live marketplace data that a brand SportLots has no entry for can be linked
THROUGH SportLots' "All Brands" option, narrowed by an NB-owned set-name
prefix, and that Sync Sets is two-sided (BSC filed by prefix / into `Unknown`,
then SportLots asked per brand). **NEO-306 changed what the SportLots phase
does with what it finds:** SportLots-only names are no longer saved as sets
(the 2026-09-21 auto-save is gone); each waits in its brand's review, opened
from the "N SportLots sets to sort" pill on that brand's own Sets column. This
flow never opens one (it works in the All Brands view, which has no pill);
what it reads of the SportLots phase is that it RAN — see (3) below.

Why 1997: the same SportLots brand list as 1995 (measurement 2 above — 18
entries, "1997 returns the identical list"), a full hockey year on both
marketplaces, and nothing else in the suite touches it. The year is COLD on
every CI run; the flow pays its own syncs on its own runner.

| | |
| -- | -- |
| ancestors | `Hockey → 1997` |
| what the flow WRITES | a manufacturer row **`SPx`** (via "+ Custom"; the create itself links it through All Brands because the year carries SportLots ids — there is no opt-in on the confirm since Jason's 2026-09-21 preview pass; prefix defaulted to its name); the per-brand SportLots reviews the year-wide sync writes (NEO-306; 74 SportLots-only names measured on the first run, see (3) below — unsaved, never read or asserted); the year-wide BSC filing (every brand plus `Unknown`) and the re-home of `SPx…` sets out of `Unknown` |
| what it never does | fetch a checklist, map a Base (the picker is cancelled), rename or delete anything |
| writer | **sole writer** of the whole year; no other flow may drill Hockey 1997 |
| pre-synced by `setup.yaml` | **no** |
| re-runs | **fresh-only per deployment** (same contract as the 1995 fixture): a second run finds `SPx` already there, the "+ Custom" form SELECTS it with no confirm, and STEP 3 fails on the confirm sentence by name. Re-seed before re-running locally |

**The prefix is `SPx`, MEASURED 2026-09-21** on PR #272's Convex preview
(local Vite pointed at the preview after CI run 35658444013's seed; the
flow passed end to end in 4m24s). That run still pressed the confirm's
opt-in control; the same day's preview pass removed it (the create links
through All Brands whenever the year carries SportLots ids) and pinned the
year's `Unknown` row directly under the All Brands view in the Manufacturers
column. The flow's STEP 3 no longer branches on the control and STEP 5 reads
the attributes panel's SportLots cell instead; neither the order nor those
reads have been measured yet — the next CI run of the flow is the
measurement. It was chosen from the product's constraints first and the
reading confirmed them:

* SportLots' hockey brand list has no `SPx` entry, so the product can only be
  reached through All Brands — the case the feature exists for;
* it is one regex-safe token, and the word-boundary matcher keeps it apart
  from the real `SP` brand in both directions ("SPx" does not start with
  "SP" at a boundary; "SP Authentic" does not start with "SPx");
* the 1997-98 product is small: a base set and a handful of parallels, so the
  narrowed SportLots list sits at 1–8 entries;
* and BSC's set named exactly `SPx` (1) keeps the auto-save OUT of the prefix:
  `routeSlSets` hides every SportLots entry that a set NB already has EQUALS
  or word-boundary-PREFIXES, so under `Unknown` the `SPx…` entries are
  variants of that BSC set, never new roots — nothing named `SPx…` is minted
  from SportLots, the re-home moves only BSC's rows, and (2)'s picker pane
  (the adapter's narrowed list, which `BaseSetPicker` never filters by what
  is attached) reads the same in both worlds.

What the flow needs true of the lists, which step reads each, and what was
read:

1. BSC lists ≥1 set whose name starts with `SPx` for 1997 hockey — **read:
   a set named exactly `SPx`**, filed under `Unknown` by the year-wide sync
   and re-homed by the create; STEP 4 picks it in the view and reads
   `Manufacturers: SPx — change`, STEP 5 reads "N sets moved out of Unknown";
2. SportLots' all-brands list for 1997 holds 1–8 entries starting with
   `SPx` — **read: ≥1 `SportLots base candidate: …` and no search box** in
   STEP 4's picker pane (`BaseSetPicker` renders the box above 8);
3. the year-wide sync ASKS SportLots per brand — **read: 74** SportLots-only
   names classified as new on the first run, measured through the review
   modal that stood here until 2026-09-21. Since NEO-306 those names are
   written to each brand's review, not saved as sets, and the view says
   nothing about them. STEP 2 therefore reads what the sync says about the
   SportLots side: the notice `SportLots skipped: no SportLots ids on this
   path.`, asserted ABSENT live and PRESENT under the pause —
   `syncSetsAcrossManufacturers` puts "sportlots" into `skippedSides` only
   when NOT ONE brand of the year passes the ATTACH gate, so its absence
   means SportLots was asked. Neither reading is measured yet; the next CI
   run of the flow is that measurement. The 74 stays here as what this year
   answered, not as anything a step reads, and the labels behind it are
   SportLots' business — no flow may assert one as a literal.

   **Superseded by NEO-306 (kept for the record).** The review is now the
   surface where SportLots-only names are seen and filed, proved on 2026
   Bowman (`flagship-colour-is-a-parallel-both-ways`, STEP 1). What follows
   described the auto-save world. **The gap, and the affordance that would
   close it.** No step proves a set was SAVED, because nothing on screen tells an SL-minted set from a
   BSC-filed one: a set row is not terminal, so the view shows no `SL` pill
   on it (the id is on its Base, reachable only once the set is picked BY
   NAME), and a minted row's name is a SportLots label behind a brand prefix
   — no surface names one and no flow may guess one. This fixture's own brand
   cannot supply a reachable example either: BSC's set named exactly `SPx`
   word-boundary-prefixes every `SPx…` SportLots entry, so `routeSlSets`
   mints nothing under it. That is deliberate — it is what keeps (2)'s picker
   pane identical in both worlds — and it is also why no example exists here.
   Two ways out, neither taken on the PR that removed the notice:
   * **product, preferred (an affordance, not a notice):** put a set row's
     marketplace coverage ON the row — the `SL`/`BSC` pills `EntitySelector`
     already renders for terminal rows, derived from the subtree rather than
     the set's own empty `platformData` — AND a way to REACH such a row that
     does not need its name, since a pill is not searchable. The cheapest is
     the machinery NEO-237 already built: a `leadRow` group, or a second
     pinned entry beside `All Brands — every set in <year>` whose
     `aria-label` is a flow handle by construction, for the sets this year
     has no BSC listing for. It answers a real dealer question ("which of
     these can I not pull a checklist for?"), and it gives E2E a named handle
     to the row and then to its Base's `SL` pill. Jason's call — it is a UI
     change, not a test fixture.
   * **fixture:** a brand whose BSC set does NOT prefix-cover SportLots'
     entries, so the sync mints `<BRAND> <label>` rows the flow can find by
     its own prefix. That needs a live measurement of both lists for the
     candidate year and conflicts with (2) as written here. Re-measure and
     record before changing STEP 0.

If a replacement is ever needed, swap STEP 0's `BRAND` for another 1997-98
product SportLots has no brand for and re-measure — candidates considered,
none measured: `Zenith` (Pinnacle's; fails if SportLots spells it "Pinnacle
Zenith"), `Be A Player` (ditto), `Black Diamond` (Upper Deck's; fails if
spelled "Upper Deck Black Diamond"), `Leaf` (real brand, but ~10+ SportLots
entries, so (2) needs the search-box assertion rethought). Avoid names with
apostrophes or regex metacharacters (`Collector's Choice`, `McDonald's`).

The SportLots phase is year-wide (every brand's own list, the all-brands list
once per via-All-Brands brand and once for `Unknown`), so its reviews land
under whichever brands own the names; no brand, name or count is asserted at
all (see (3)). A set row is not a terminal row, so the view shows no
`SL` pill on one — the Base-carries-the-id shape is the helper's unit test,
and the link this fixture proves live is STEP 4's narrowed picker pane under
`SPx`.

### Baseball → 1990 — the known-brands fixture (NEO-294) ✅ CLAIMED by Jason 2026-09-22

One real YEAR — **Baseball → 1990** — owned end to end by exactly one flow,
`flows/set-selector/known-brand-files-set-and-operator-move-sticks.yaml`,
which proves on live marketplace data that (a) a BSC set whose name starts
with an entry of NB's curated known-brands list (`convex/knownBrands.ts`, 39
names) is filed under a brand row the sync CREATES for it rather than under
the year's `Unknown`, and (b) an operator's later `Move to another brand`
outlives the next forced Sync Sets — the `metadata.brandSetByOperator` stamp
every automatic re-home skips.

**Why 1990, and why it replaced a proposed Hockey 1996.** 1996 was chosen
first on the reasoning that its SportLots brand list was bracketed by two
measured years; the brand it would have used (`Leaf`) was a hobby guess and
nothing about that year had been read. Jason moved the fixture on
2026-09-22: **Baseball 1990 is the year the ticket's own evidence came
from.** The collector pass read all 955 set names sitting under `Unknown` on
dev and curated the list from them, and 1990 — the great minor-league
team-set year — is the densest part of that sample. Brands the pass recorded
in THIS year's Unknown bucket: `ProCards`, `CMC`, `Star`, `Best`,
`Sportflics`, `Leaf`, `Swell`, `Perez-Steele`, `MSA`, `Little Sun`,
`Kenner`, `Eclipse`, `Boxscores`, `Mother's Cookies`. So "this year holds a
set the list claims" is a measurement rather than a guess.

**The brand the flow uses is `CMC`**, chosen off that measured list in this
order: not an English word (so it cannot quietly match an unrelated set —
that rules out `Star`, `Best`, `Eclipse`, the three the module itself flags
as accepted risks); no apostrophe (rules out `Mother's Cookies`, whose match
is one typographic apostrophe away from failing safe); one regex-safe token
with no whole-word prefix relation to any other entry; a MINOR-LEAGUE issuer,
so SportLots' baseball brand list almost certainly has no entry for it —
which is what keeps the claim honest once the pause lifts, and what rules out
`Leaf`, a major baseball brand of the era SportLots very likely does carry;
and the most numerous of the remaining names in the sample (`CMC` 27 against
`ProCards` 6, `MSA` 2, `Little Sun` 2, `Kenner` 2, and a handful of ones).
`ProCards` is the drop-in replacement, then `MSA`, `Sportflics`,
`Boxscores`, `Swell`, `Kenner`. Changing it is a one-line edit to the flow's
STEP 0.

| | |
| -- | -- |
| ancestors | `Baseball → 1990`, reached through the pinned All Brands view |
| what the flow WRITES | every brand row the known list mints for the year (expected `CMC` among others), the year's `Unknown` row, the year-wide BSC filing of every set under one of them, and ONE operator move of a `CMC…` set into `Unknown` (stamped `brandSetByOperator`) |
| what it never does | fetch a checklist, map a Base, rename or delete anything, create a brand by hand, or add a row to Baseball's shared Years column |
| writer | **sole writer** of the whole year; no other flow may drill Baseball 1990 |
| pre-synced by `setup.yaml` | **no** — the flow pays its own cold syncs on its own runner |
| re-runs | **fresh-only per deployment**, the same contract as the 1995 and 1997 hockey fixtures: a second run finds the set already under `Unknown` and already stamped, so the flow's `Manufacturers: CMC — change` assertion fails by name. CI reseeds the preview every run, so the first-run path is the CI path; re-seed before re-running locally. The flow deliberately does NOT restore the set — a restore would make a re-run green while proving the filing from the operator's own move rather than from the list |

**The shared-sport question, answered: it adds no row above set level.**
Baseball's Years column is synced from the marketplaces and already holds
1990, and the year level of `util-drill-to-cold-real-set` has no create path
at all (it goes red if the row is missing). Everything this flow creates
lands in the Manufacturers column of 1990, which nothing else drills. The
fold hazard in "Adding ROWS to a shared column" below therefore does not
apply, even though the SPORT is the one twenty other flows use.

#### What the first CI run must still measure

The collector pass read DEV. The flow runs against a PR preview seeded from
empty, and nothing had been pushed when it was written, so no reading was
possible against the code under test. Confirm and record here:

1. **BSC lists ≥1 set for Baseball 1990 whose name word-boundary-starts with
   `CMC`** — read off the flow's `Manufacturers: CMC — change` card. Swap
   STEP 0's `BRAND` from the ordered list above if not.
2. **The cost**, against `run-e2e-queue.sh`'s 600s per-flow kill. This is the
   open question the move to 1990 trades for certainty: it is a far bigger
   year than Hockey 1997, and the flow pays the year-wide Sets sync TWICE
   (cold, then forced). The only comparable figure is
   `brand-via-all-brands-narrows-sportlots` on Hockey 1997 — 4m24s for ONE
   year-wide sync that also made ~18 live SportLots POSTs this flow never
   makes. If the total lands near the kill, the cheap fix is to drop the
   flow's final re-pick (the breadcrumb and the card say the same thing
   twice); the expensive one is a smaller year, for which `Sportflics` (a
   mainstream 1986-90 issue) would be the brand.
3. **That the year stays under the two caps that would make the flow lie.**
   `MAX_SETS_PER_YEAR_VIEW` (1000) bounds what the All Brands view LISTS —
   past it the flow's filter could come back empty, which is a red, not a
   wrong green. `MAX_YEAR_SET_ROWS` (3000) bounds the year index — past it
   `plan.moves` is skipped WHOLESALE ("too many sets this year to move any
   out of Unknown"), which would make the survives-a-sync half pass
   **vacuously**, with no on-screen signal at all. Read the Convex log for
   `year set index truncated` on the first run. Both caps are well above "a
   few hundred BSC sets" — `setFromMarketplace`'s own description of a full
   baseball year — but 1990's minor-league team sets are exactly the tail
   that makes a year unusually long.
4. **Nothing about the known-brand COUNTS.** `syncSetsAcrossManufacturers`
   puts "N brands added from the known list" / "N sets filed under a known
   brand" into its `summary`, which reaches only `res.message` — and
   `ensureSelectorOptions` composes the column's done row from `pausedSides`
   / `failedPlatforms` / `skippedSides` / `unlinkedTotal` and nothing else,
   dropping `res.message` on success (`slCreated` was the one count that
   reached it; that sentence was removed 2026-09-22 — see the Hockey 1997
   section). Those two sentences have
   **no UI surface** and no flow may target them. The flow asserts the
   STRUCTURE instead (which brand row the set hangs off), which is the
   stronger claim anyway.

#### Why it cannot be a per-worker hand-made fixture

The known list is consulted inside `syncSetsAcrossManufacturers`, on the sets
a marketplace returned. A hand-made subtree carries no ids, so neither side
is resolvable, nothing is fetched and there is nothing to file (NEO-239) —
and with nothing to sync there is no automatic re-home for the operator's
stamp to survive either. The move CONTROL itself needs no marketplace, and
that half lives marketplace-free in `move-set-to-another-brand.yaml`
(`msb-` prefix below); only the two claims above need a real year.

### The TEAM-link alias fixture — Baseball / 2024 / Topps / Topps MLB at Rickwood Field Negro Leagues Collection (NEO-284) — approved by Jason 2026-09-16

One new real set, touched by exactly one flow,
`checklist-wizard-link-team-saves-alias.yaml`, which fetches and COMMITS its
checklist. Rule 1 above applies: this is a proposal for the owner, not an
approval. Measured live on PR #262's Convex preview on 2026-09-16.

**What the flow proves** (NEO-284): a "Link to Existing…" decision on a TEAM
row in the entity-review wizard keeps the checklist's raw spelling as an alias
of the linked team, by default, and the alias is written at COMMIT — so it
needs a real set whose wizard opens on a TEAM row, and it needs to commit.

**Why this set.** The suite's only teams are the MLB clubs `setup.yaml`'s
Topps Chrome commit creates, so a team row needs a set whose clubs are not
MLB clubs — and the three committing fixtures above are team sets of MLB
clubs (0 unknown teams each) or already spoken for (Brooklyn Collection, 1
team, sole writer `checklist-wizard-link-commits`). Among the 167 sets BSC
lists under 2024 Topps this is the smallest with that shape:

| | |
| -- | -- |
| BSC cards | **4** — RW-1 Satchel Paige, RW-2 Josh Gibson, RW-3 Jackie Robinson, RW-4 Willie Mays |
| unknown names | **8** — 4 players, the Negro League clubs (Pittsburgh Crawfords, Homestead Grays, …), and ONE staged league ("Negro league baseball", raised by the first club's Wikidata lookup and asked once for the batch) |
| first row presented | the staged **League** step; the flow skips it ("Skip — no league") and the first **team** row follows |
| cost | ~60s to the wizard on a warm Baseball drill, ~3 min end to end |

**It is ONE-SIDED, and the flow keeps it that way.** SportLots does not carry
this set. The base picker's SportLots column is the year's whole catalogue —
"Base Set" flagged "likely match" is 2024 Topps flagship (352 cards); the rows
under it are 1989 Topps inserts — so the honest operator action is to CANCEL
the picker. The author's first probe attached that "likely match" by taking
the util's first-candidate path, and it paired 0 of 4 cards (BSC only 4 /
SportLots only 352). Cancelling leaves exactly one attached side (the BSC slug
Sync Variant Types wrote on Base), so the fetch takes the NEO-255 solo path —
no Match Cards dialog, "Kept all 4 cards from BSC", straight to the review.
That is the Roanoke Express shape above, on a warm drill.

**Not through `util-fetch-real-set-checklist-to-wizard`**, which waits on the
two-sided Match Cards dialog this set never shows. The flow hand-rolls the
Base tap → picker cancel → sync, exactly as the one-marketplace flow does.

**Sole writer, self-cleaning on the TEAM side.** The flow links the first
club to a per-attempt team it created (`Loc<token> Ali<token>`), commits,
reads the alias back in Team Management, then REMOVES it and saves. So the
alias never outlives the flow: while it exists, any checklist naming that
club would resolve to the flow's own team through the alias union, which is
the feature — and why it is taken out again before the flow ends. The set
itself drains within a run like the other committing fixtures (a committed
set's names are known; a re-sync raises no review), and CI reseeds every run.
A LOCAL re-run needs a fresh seed.

**Concurrency.** No other flow reads this set, and nothing reads
`Loc<token> Ali<token>`. The four read-only Big League flows and the three
committing fixtures share no `selectorOptionId` with it.

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
| `cpx-` | `set-attributes-card-prefix.yaml` — an Insert row `CPXROW` under it carries the Card prefix under test; the flow clears the prefix before it ends. |
| `cvar-` | `variation-link-group-and-unlink.yaml` |
| `fp-` | `features-propagation.yaml` |
| `ftl-` | `set-fill-teams-from-teammate-card.yaml` (also `-${ATTEMPT_ID}`) — under `E2E Test Sport <w>` › 2026 › Topps, the `stt-` shape for the same League-row reason. Per-attempt because the Fill teams confirm's title and toast are EXACT card counts. Its two cards are deleted at the end; the set, its `Insert` › `Base` rows, its player `FTP<token>` and its team `FTT<token>` stand. The set is given NO set-level team (NEO-277 would copy it onto every card and leave nothing to fill). |
| `msb-` | `move-set-to-another-brand.yaml` — its OWN sport `msb-sport-<worker>`, brand rows `Topps` / `Panini` under it in 2026 (hand-made, no ids), and ONE set `msb-a-<worker>` under `Topps`. The flow moves that set to `Panini` and back, so it ends where it started; `Panini` stays empty. Per-worker only (no count is asserted). **Never under `E2E Test Sport <worker>`** — it adds a brand row, see the fold note below. |
| `parallel-feature-` | `cards-parallel-custom.yaml` |
| `pg-cancel-` | `parallel-grouping-cancel-discards.yaml` (also `-${ATTEMPT_ID}`) |
| `pg-demote-` | `parallel-grouping-demoted-parallel-takes-parallels.yaml` (also `-${ATTEMPT_ID}`) — three inserts `<ATTEMPT_ID> Stars` / `Stars Gold` / `Stars Blue`; Gold and Blue are saved as parallels of Stars, then Gold is demoted and Blue re-parented under it in one save (NEO-300). Per-attempt because the flow taps inside the Group Parallels body at positions that hold only for exactly these three rows. |
| `pg-move-` | `move-parallels-of-inserts-custom.yaml` |
| `pg-multi-` | `parallel-grouping-multi-select-moves-together.yaml` (also `-${ATTEMPT_ID}`) — three inserts `<ATTEMPT_ID> Aces` / `Bolt` / `Comet`, none a prefix of another so nothing is suggested; Bolt and Comet are ticked together and saved as parallels of Aces in one save (NEO-300). Per-attempt because the flow taps inside the Group Parallels body at positions that hold only for exactly these three rows. |
| `pg-reject-` | `parallel-grouping-reject-parallel.yaml` (also `-${ATTEMPT_ID}`) |
| `pp-` | `player-picker-create-custom-card.yaml` |
| `rnm-` | `rename-selector-option.yaml` (also `-${ATTEMPT_ID}`; renamed in-flow to `rnmx-`) |
| `stt-` | `set-team-carries-down-to-cards.yaml` (also `-${ATTEMPT_ID}`) — under `E2E Test Sport <w>` › 2026 › Topps, NOT Baseball: the New Team dialog's League row lists every league the sport holds in a `max-h-40` inner scroller maestro-web cannot drive, and under the synthetic sport the only pill is `No league`. Per-attempt because the cascade confirm's body is an EXACT card count. Its two cards are deleted at the end; the set, its `Insert` › `Base` rows and its three teams stand. |
| `tlf-` | `checklist-title-length-limits-and-fixer.yaml` (also `-${ATTEMPT_ID}`) |
| `tp-` | `team-picker.yaml` |
| `tpc-` | `team-picker-create-custom-card.yaml` |
| `WOSet3-` | `new-chain-autopopulates-features.yaml` (under synthetic `E2E Test Sport N`) |
| `xb-` | `all-brands-view-lists-every-set.yaml` — its OWN sport `xb-sport-<worker>`, brand rows `Topps` / `Panini` under it in 2026 (hand-made, no ids), and one set under each: `xb-a-<worker>` (Topps) / `xb-b-<worker>` (Panini). Per-worker only (no count is asserted). **Never under `E2E Test Sport <worker>`** — it adds a brand row, see the fold note below. |
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

**NEO-237 spends one of those rows in EVERY Manufacturers column:** the pinned
"All Brands" view entry sits above the data rows, so `E2E Test Sport <w> ›
2026` now shows two rows (the view, `Topps`) where it showed one, and the
`xp-` / `xb-` private sports show three. Not counted toward the search
threshold, never filtered, and no drill targets it by position — but it is
~58px of column everywhere. The first preview run of the suite is what
confirms `Add custom Manufacturers` still clears the fold in those columns;
if it does not, the fix is the product's (headroom), never a scroll in
`util-drill-to-custom`'s unscrolled Level-3 wait.

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
| `FTP` | `set-selector/set-fill-teams-from-teammate-card.yaml` | a PLAYER — the one both of that flow's cards name; created from the quick-add form's PlayerPicker on card #781 and PICKED from its results on card #782 (the only flow that selects an existing player there). `FTT` below is his team; the two diverge at their third character |
| `FTT` | `set-selector/set-fill-teams-from-teammate-card.yaml` | the team card #781 is born with and card #782 borrows through Fill teams. Carries the Location `Loc<token>` (typed into the DIALOG, never into a picker) so the composed `Loc<token> FTT<token>` is what rows, chips and the Fill teams ledger print |
| `NBTeam` | `team-picker-create-custom-card.yaml` | created under `E2E Test Sport <w>`, not Baseball |
| `NBPlayer` | `player-picker-create-custom-card.yaml` | a PLAYER, not a team — `players.search` tokenises identically, and the row persists the same way |
| `PM` | `admin/player-management-add-and-career-history.yaml` | the PLAYER this flow adds by hand; `PMT` below is the team it gives him. The two diverge at their THIRD character, so neither name is a prefix of the other and neither picker can be answered by the other's row |
| `PMT` | `admin/player-management-add-and-career-history.yaml` | |
| `SLP` | `spine-label/player-team-colors-default-to-longest-tenure.yaml` | the PLAYER; `SLA`/`SLB` are his two teams. This is the one flow that types a strict PREFIX of a minted name — see the prefix note below |
| `SLA`, `SLB` | `spine-label/player-team-colors-default-to-longest-tenure.yaml` | coloured `#132448` / `#002d72` |
| `STA`, `STB`, `STC` | `set-selector/set-team-carries-down-to-cards.yaml` | three teams under `E2E Test Sport <w>`, diverging at their THIRD character so none is a prefix of another. Each carries the Location `Loc<token>` (typed into the DIALOG, never into a picker, so the composed `Loc<token> STA<token>` is never queried) — the same shape `admin/admin-franchises-link-teams.yaml` gives its `Fr<token>A`/`Fr<token>B` pair, so `TMT` is no longer the only located team. STA is the set's first team, STB is card #2's hand-set override, STC is the set's replacement |
| `TLF` | `checklist-title-length-limits-and-fixer.yaml` | kept SHORT on purpose: the name lands in a generated listing title measured against an 80-character cap. `TLF<token>` is 8-12 chars, 3 fewer than the `TLF-${ATTEMPT_ID}` it replaced and 4-8 fewer than the "New York Yankees" before that — the rename spends less of the budget, never more. Read the FIXTURE SIZING block in the flow before changing any name in it |
| `TME` | `admin/team-management-edit-a-team.yaml` | the throwaway PLAYER that flow creates on the way in, because a career editor is the only place outside the set-builder cascade where a team can be born. `TMT` below is the team it makes there; the two diverge at their third character |
| `TMT` | `admin/team-management-edit-a-team.yaml` | the ONLY team in the suite with a `location` (`Loc${WORKER_INDEX}`), so once it saves its composed name is `Loc<w> TMT<token>` — see the composed-name note above for why the extra term is inert |
| `Alp` | `set-selector/checklist-wizard-link-team-saves-alias.yaml` | the throwaway PLAYER that flow creates to reach a career editor; `Ali` below is the team it makes there. The two diverge at their third character |
| `Ali` | `set-selector/checklist-wizard-link-team-saves-alias.yaml` | the team a checklist club is LINKED to; carries the Location `Loc<token>` (typed into the DIALOG, never into a picker), so the composed `Loc<token> Ali<token>` is what the link option, the decision line and Team Management print. The link SEARCH types the single token `Ali<token>`. Its alias (the club's marketplace spelling) is removed again before the flow ends |
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
