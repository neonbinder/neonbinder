# E2E Set Registry

Every set the Playwright suite touches is listed here. Two rules govern this file:

1. **Adding a new REAL (marketplace-backed) set requires explicit owner approval,
   every time.** A real set costs a 30–90s BSC/SL sync on first use. The
   marketplaces carry essentially every set ever printed, so the constraint is
   cost and determinism, not availability. Ask before adding one — do not add a
   real set because it seemed convenient.
2. **Every custom set prefix must be registered below before use.** The registry
   exists so two flows never silently collide on the same name.

## Real marketplace-backed sets

These are provisioned once by `tests/setup.spec.ts` at the head of every run and are
**READ-ONLY for all other flows**.

### When SportLots is paused (NEO-287) every real set is BSC-ONLY

**Today it is not paused.** SportLots was unpaused on 2026-09-21 (NEO-288's
automated-access handshake removed the reason; the repository variable was
deleted), so every CI run passes `PAUSED_PLATFORMS` empty and every set below
is provisioned LIVE, from both marketplaces. This section describes the
paused mode the flows still branch on; check which one a run used with
`gh run view <run-id> --log | grep -m1 "PAUSED_PLATFORMS: "` (empty = live)
before reading a failure against it.

The operator switch `NEONBINDER_PAUSED_PLATFORMS=sportlots` (mirrored to the
flows as `-e PAUSED_PLATFORMS`; README → "Operator switches") means nothing is
asked of SportLots, so under it every row in this table is provisioned from
BuySportsCards alone for the whole run:

* **2024 Topps Chrome** — `Base` (335 cards) and `Insert` → Future Stars
  fetched on the NEO-255 one-marketplace path: every BSC card kept, no
  `Match Cards` dialog, every row a solo-kept "BSC only" card with no `SL`
  badge and no SportLots id anywhere in the chain. `Parallel` → Gold Wave
  Refractors is BUILT FROM BASE (NEO-321) from BSC alone, so its copies
  carry Base's "BSC only" tag and no `SL` badge either. The Base is confirmed **BSC-only** in the picker by
  the seed. Because `baseHasMapping` counts the SportLots slot only, such a
  Base still reads as unmapped: every later drill auto-opens the picker
  again, and `drillToBaseVariant` leaves it the no-write way
  (Cancel → Close → "Map Base Set") on every read-only set.
* **Manufacturer rows are hand-made.** NeonBinder's Manufacturer rows come
  from SportLots' brand list and nowhere else (`convex/platformLevels.ts`), so
  under the pause the Manufacturers column syncs to nothing and the row is
  added through the column's own "+ Custom" form by the path's **sole
  writer**: `Topps` under Baseball → 2024 by `tests/setup.spec.ts`; `Score` under
  Baseball → 1996 by `inserts-1996-score-…` (via `CREATE_MANUFACTURER: "1"`
  on the drill); `Topps` under Hockey → 2024 by `set-rename-…` (via
  `drillToColdManufacturer`, which adds a ROW under the pause), and
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
| Baseball → 2024 → Topps → Topps Chrome | `Base` (full checklist), `Insert` → "Future Stars" (~20 cards), `Parallel` → "Gold Wave Refractors" (300 cards, BUILT FROM BASE since NEO-321 — copies of Base's cards linked to Gold Wave's own BSC + SportLots cards) | `tests/setup.spec.ts`; **sole writer** of the cards of the base parallel its run builds before Stop (the first buildable row under `Parallel`, in the type's child order — measured: `Sepia Refractors`): `tests/set-selector/base-parallels-build-from-section.spec.ts` (NEO-321) — see "2024 Topps Chrome › Parallel — the base-parallel build". Approved: Jason, 2026-10-04 |
| Baseball → 2024 → Topps → Topps Big League | `Base` — variant types synced and Base MAPPED, checklist deliberately EMPTY (NEO-248 wizard fixture) | `tests/setup.spec.ts` |
| Baseball → 2024 → Topps → Topps 206 | none — variant types sync on first use; Base stays **UNMAPPED** (NOT pre-synced) | `tests/set-selector/base-mapping-cancel-recovers.spec.ts` — **sole writer**, and it writes nothing |
| Hockey → 1995 → Unknown (via the All Brands view) → Tulsa Oilers CHL | `Base` — 18 cards, fetched and COMMITTED in-flow, BSC only, every name SKIPPED (NOT pre-synced) | `tests/set-selector/checklist-wizard-skip-commits-and-unskip.spec.ts` — **sole writer**. ✅ **Approved by Jason 2026-10-10** (NEO-330). Measured: **16 unknown players, 0 teams** (19 review rows once three players' Wikidata career clubs are staged) — see "The 1995 minor-league hockey wizard fixtures" |
| Hockey → 1995 → Unknown (via the All Brands view) → Memphis RiverKings CHL | `Base` — 18 cards, fetched and COMMITTED in-flow, BSC only; ONE player created with ONE hand-staged career team, the rest SKIPPED (NOT pre-synced) | `tests/set-selector/checklist-wizard-career-team-commits.spec.ts` — **sole writer**. ✅ **Approved by Jason 2026-10-10** (NEO-330). Measured: **15 unknown players, 0 teams** (15 rows settled) |
| Hockey → 1995 → Unknown (via the All Brands view) → San Antonio Iguanas CHL | `Base` — 18 cards, fetched and COMMITTED in-flow, BSC only; one row LINKED to the catalogue's Wayne Gretzky, one moved to Football and linked to the minted `Gw<token>`, the rest SKIPPED (NOT pre-synced) | `tests/set-selector/checklist-wizard-link-commits.spec.ts` — **sole writer**. ✅ **Approved by Jason 2026-10-10** (NEO-330). Measured: **16 unknown players, 0 teams** (16 rows settled) |
| Hockey → 1995 → Unknown (via the All Brands view) → Fort Worth Fire CHL | `Base` — 18 cards fetched in-flow, BSC only, and DISCARDED (Cancel → Discard; nothing saved) (NOT pre-synced) | `tests/set-selector/checklist-wizard-skip-not-a-person.spec.ts` — **sole reader**, writes nothing. ✅ **Approved by Jason 2026-10-10** (NEO-330). Measured: **16 unknown players, 0 teams** (16 rows settled) |
| Baseball → 2024 → Topps → Topps Heritage | `Base` — SportLots base mapping CONFIRMED in-flow (NOT pre-synced) | `tests/set-selector/sets-base.spec.ts` — **sole writer** of that mapping. ✅ **RATIFIED 2026-09-09** (NEO-260) — it was already in use and had never been listed |
| Baseball → 1996 → Score → Score | `Insert` (reconciled in-flow, NOT pre-synced) | `tests/set-selector/inserts-1996-score-one-nb-set-two-bsc-sources.spec.ts` — **sole writer** |
| Hockey → 2024 → Topps → Topps NHL Sticker Collection | none — the flow never goes below `Variant Types` (NOT pre-synced) | `tests/set-selector/set-rename-survives-resync-and-suggests-bsc-name.spec.ts` — **sole writer** |
| Hockey → 1995 → Unknown (reached through the All Brands view) → Roanoke Express ECHL | `Base` — 25 cards, fetched and COMMITTED in-flow, BSC only (NOT pre-synced); NEO-335: one player CREATED in the review with one career team (`RXT<token>`, pre-filled onto his card), one card answered "No team on this card", one given a team CREATED with "Other team…" (`RXO<token>T`), 22 left for later; then RE-SYNCED once (teams-only review) | `tests/set-selector/checklist-one-marketplace-skips-match-dialog.spec.ts` — **sole writer**. ✅ **APPROVED 2026-09-09** (NEO-260); manufacturer row renamed by NEO-237 (the marketplace's "All Brands" option is routed onto the year's `Unknown` row, never stored under its label) |
| Hockey → 1997 (the whole year) | a manufacturer row `SPx` linked through SportLots' All Brands option; the per-brand SportLots reviews the year-wide Sync Sets leaves behind (NEO-306: SportLots-only names are no longer saved as sets; the reviews stay unsaved, labels never read or asserted); the year's BSC sets filed under the brands / `Unknown` and the prefix-matching ones re-homed to `SPx`. No checklist is fetched. | `tests/set-selector/brand-via-all-brands-narrows-sportlots.spec.ts` — **sole writer** of the year. ✅ Claimed by Jason 2026-09-21 (NEO-237 §0.1); the prefix `SPx` **measured** on PR #272's preview 2026-09-21 — see the Hockey 1997 section |
| Baseball → 2024 → Topps → Topps MLB at Rickwood Field Negro Leagues Collection | none since NEO-330 — RETIRED as a fixture: the reference catalogue holds its Negro League clubs and players, so it no longer raises the team steps the alias flow needs | was `tests/set-selector/checklist-wizard-link-team-saves-alias.spec.ts` (NEO-284, approved 2026-09-16); no flow touches it now |
| Baseball → 1996 → All Brands (the view; the set is filed under the year's `Unknown` row) → Line Up Venezuelan Winter League | `Base` — 300 cards, BSC only (the SportLots picker is CANCELLED in-flow), fetched and COMMITTED in-flow (NOT pre-synced): one club LINKED to the minted `Loc<token> Ali<token>` with its alias, every other name SKIPPED | `tests/set-selector/checklist-wizard-link-team-saves-alias.spec.ts` — **sole writer**. ✅ **Approved by Jason 2026-10-10** (NEO-330). Measured: **200 unknown players + 8 unknown teams** (211 rows once lookups settle) — see "The TEAM-link alias fixture" |
| Baseball → 2025 (the whole year) → Topps → Topps Welcome to the Club: 3X MVP | `Base` — 36 cards, BSC only (the SportLots picker is CANCELLED in-flow), fetched and COMMITTED in-flow (NOT pre-synced): the one team step, `Philadelphia Athletics`, LINKED by the operator to the catalogue's 1901–1954 row (remember-box unticked, no alias written); Brooklyn Dodgers linked automatically at the fetch. The year's Manufacturers and Topps Sets syncs are this flow's too: no other flow drills Baseball → 2025 | `tests/set-selector/checklist-wizard-past-era-team-link-commits.spec.ts` — **sole writer** of the year. ✅ **Approved by Jason 2026-10-11** (NEO-330). Measured: **0 unknown players + 1 unknown team** (1 row once its lookup settles) — see "The PAST-ERA team fixture" |
| Baseball → 2026 → Bowman (the whole brand-year) | **setup:** Bowman's Sets synced and its SportLots review SAVED (NEO-306): the set `Bowman Sterling` (+ Base), `All-America Game Autos` under Bowman › `Insert`, every other SportLots-only name under Bowman › `Parallel`; Bowman's Variant Types synced. **inserts flow:** Bowman › `Insert` reconciled and grouped — `Anime Kanji` promoted to a parallel of `Anime`, re-synced; `Anime`'s checklist COMMITTED, which BUILDS all of `Anime`'s parallels (NEO-312). **links flow:** Bowman › `Parallel` re-synced and saved (BSC's `Blue` paired with the filed row); `Blue`'s SportLots link promoted to `Bowman Blue` and folded back; the Parallel row `All-America Game Autos Red Ink` moved under Bowman › Insert › `All-America Game Autos` as the parallel `Red Ink` | `tests/setup.spec.ts` (Sets + review + Variant Types; the paused-mode `Bowman` manufacturer row), `tests/set-selector/bowman-insert-grouping-builds-parallels.spec.ts` (Bowman › Insert's BSC inserts and their grouping), `tests/set-selector/bowman-sportlots-links-move-between-set-parallel-insert.spec.ts` (Bowman › Parallel, `Blue`, `Bowman Blue`, `Red Ink`) — **one sole writer per row**, split from one flow at 570 s of the 600 s kill (NEO-312, owner-approved shape). Requested by the owner 2026-09-21 (NEO-293) |
| Baseball → 1990 (the whole year) | Every brand row NB's known-brands list mints for the year, the year's `Unknown` row, and every BSC set of the year filed under one of them; one set (expected `CMC…`) is MOVED to `Unknown` by the operator control and left there. No checklist is fetched, no Base is mapped, nothing is renamed or deleted, and NO row is added to Baseball's shared Years column (1990 is synced, and the drill selects it). | `tests/set-selector/known-brand-files-set-and-operator-move-sticks.spec.ts` — **sole writer** of the year. ✅ Claimed by Jason 2026-09-22 (NEO-294); see the Baseball 1990 section |
| Baseball → 2025 (the whole year) | the year's Manufacturers and year-wide Sets synced cold in-flow (SportLots' Bowman review left UNSAVED); `Bowman Draft`'s Variant Types synced; Bowman Draft › `Insert` reconciled and SAVED (every Ready set, the `Prospect Dual Autographs` family made its own sets by "Keep all"); `Prospect Dual Autographs`' checklist COMMITTED (on the catalogue every name is known, so the fetch commits with no wizard; any name the wizard does stage is SKIPPED) — no player, team or league minted (NOT pre-synced) | `tests/set-selector/checklist-dual-team-card-links-both-teams.spec.ts` — **sole writer** of the year, not self-cleaning (the run-start reset is its cleanup). Owner chose an uncontested set, 2026-10-10 (NEO-333 option B); see "Baseball → 2025 — the NEO-333 dual-team fixture" |
| Baseball → 2024 → Topps → Topps (the flagship: BSC's Series 1 + 2 set) | `Insert` — Variant Types synced on first entry; the `Insert` reconcile SAVED twice (once built, once re-synced): every Ready set it holds, including `City Connect Swatch Collection Relics (Series One)` linked to SportLots **299607** and `… (Series Two)` linked to **307437**. No checklist is fetched (NOT pre-synced; the `Topps` row itself is the seed's 2024 Topps Sets sync) | `tests/set-selector/reconcile-sportlots-twins-save-each-to-its-own-set.spec.ts` — **sole writer**, not self-cleaning (the run-start reset is its cleanup). ✅ Approved by Jason 2026-10-08 (NEO-325); see "SportLots twin names" |
| Football → 2014 (the whole year) → Topps → Topps (the flagship) | `Base` — the year's Years, Manufacturers and year-wide Sets synced cold in-flow; `Topps`' Variant Types synced; the Base picker CONFIRMED on both sides; the checklist fetched and COMMITTED in-flow through the Match Cards dialog, with BSC's #442 deliberately linked to a SportLots-only card and saved under the SportLots name; any review-wizard names SKIPPED (NOT pre-synced) | `tests/set-selector/checklist-team-leader-cards-pair-and-picked-name-saves.spec.ts` — **sole writer** of the year, not self-cleaning (the run-start reset is its cleanup). ✅ **Approved by Jason 2026-10-13** (NEO-343/NEO-344) — see "Football → 2014 — the NEO-343 team-leader fixture" |

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
| drills | Hockey → 2024 → Topps → `Topps NHL Sticker Collection`, all four levels COLD (see `drillToColdManufacturer` in support/set-builder.ts) |
| writes | renames the set row to `TCG`, forces `Sync Sets`, then ACCEPTS BSC's suggestion |
| leaves | the set named **`Topps NHL Sticker Collection`** again — accepting restores the baseline, so the flow is idempotent |
| never touches | cards, players, teams, or anything below `Variant Types` |

The flow tolerates a run that died between the rename and the accept (the row
left as `TCG`) by selecting on the regex `Topps NHL Sticker Collection|TCG` and
skipping the rename when the row already reads `TCG`. CI never needs that:
`tests/setup.spec.ts` resets the set-builder tables at the head of every run, so the set
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

* ~~`EntitySelector` renders a column's search input only above 8 entries.~~
  **Superseded by NEO-224:** every open column renders exactly one search box
  (the column's combobox and the cascade's focus target) — loading, empty or
  full. So the box is no longer a "this column has rows" signal: gate on the
  column's LISTBOX (`id: "<Column title>"`, rendered only once the column holds
  a row), or type the row's name first and wait for the filtered row under the
  box. (`BaseSetPicker`'s own search boxes keep their above-8 rule.)
* An **empty** column renders its `Sync <X>` / `+ Custom` buttons immediately and
  only switches to the `Syncing <X>` panel once `ensureSelectorOptions` has
  round-tripped. So "the idle button is visible" is NOT proof the column has
  data — a probe on 2026-09-03 dumped an empty Sets column at exactly that
  moment. `drillToColdManufacturer` (support/set-builder.ts) waits out the `Syncing <X>` panel
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
| its NB insert row's name | carries a ` NB211-<ATTEMPT_ID>` suffix (NEO-211, below) — applied at STEP 3b, BEFORE the card fetch (NEO-335 Phase 2) |
| its NB insert row's `Short name for titles` | `DCAP<token>`, written by the commit from the wizard's Card titles step (NEO-335 Phase 2, below); every card title the commit writes uses it |

**NEO-203 — the flow now re-syncs the set once more before it ends.** Its
STEP 7 edits the first card's name in NeonBinder, re-fetches the same
checklist, and declines the marketplace's competing name in the re-sync review
dialog. Two consequences worth knowing:

* The set is left with **220 cards still**, but the first card's NeonBinder
  name carries the run's `ATTEMPT_ID` marker. Nothing else reads that card, and
  `tests/setup.spec.ts`'s reset clears it at the head of every run, so it accumulates
  only across local re-runs that skip a reseed.
* This is the ONLY end-to-end coverage of the re-sync content-diff review, and
  it lives here rather than in its own flow because the costly part of testing
  a re-sync is having a committed marketplace-backed set to re-sync — which
  this flow has just built, and which the sole-writer rule below forbids a
  second flow from building.

**NEO-335 Phase 2 — the Card titles step and the short name for titles.** A
card under an insert row now carries the insert's name in its title core, so
the flow renames the insert row to its NB211 marker at STEP 3b, BEFORE the
first card fetch (the rename used to open STEP 8): with that ~50-character
insert name nearly every card's title core is cut, which makes the wizard's
`Card titles` step certain. STEP 6c types `DCAP<token>` into its `Shorter set
name for titles` field, asserts `Every title fits now.`, and saves; STEP 7a
reads `1996 Score DCAP<token> …` off a stored card's title. So the insert row
also ends with `metadata.listingShortName = DCAP<token>`, and all 220 card
titles use it. Nothing else reads either.

**NEO-211 — the flow now also re-syncs the INSERT LEVEL once, after all of
that.** Its STEP 3b renames the single insert row (appending ` NB211-<ATTEMPT_ID>`);
its STEP 8 then forces `Sync Inserts`, saves the reconcile dialog with no edits, and then
DECLINES both marketplaces' competing names in the new Name Suggestions dialog.
Consequences worth knowing:

* The set still ends with **exactly ONE** insert row and **220** cards. Only the
  insert row's NAME changes, and it changes to a per-attempt marker for the same
  reason the NB203 card marker does — it has to be unmistakably ours and unique
  to the run. `tests/setup.spec.ts`'s reset clears it at the head of every run.
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
pre-synced by `tests/setup.spec.ts` and is NOT read-only: the reconciliation IS the
thing under test, so the flows must perform it.

Exactly ONE flow may ever touch this set —
`tests/set-selector/inserts-1996-score-one-nb-set-two-bsc-sources.spec.ts`. Adding a second would
reintroduce the cross-runner interference the read-only rule exists to prevent.

It was briefly split into a producer/consumer pair on the old `provides:`/`requires:`
dependency graph. That was wrong, and the graph is gone (NEO-260): nothing
schedules one flow after another. `run-e2e-queue.sh` enqueues in LPT order
(alphabetical without timing history) and 8 runners claim from a shared queue
with no dependency handling. Any flow in that queue must be independent of every
other. Keeping it out of `tests/setup.spec.ts` also means its sync cost is paid by one
flow rather than added to every run's seed.

**No other real set exists in the suite.** If a flow needs marketplace-backed
data that isn't in the table above, it must either sync it itself (and accept the
30–90s cost, with owner approval) or — far more often the right answer — use a
per-worker custom set (see below).

### 2026 Bowman — setup + two concurrent flows, one sole writer per row (NEO-293, NEO-300, NEO-305, NEO-306, NEO-308, NEO-312)

Baseball → 2026 → Bowman is written by `tests/setup.spec.ts` and two flows that run
CONCURRENTLY against the same preview. Together they prove, in order, where
each marketplace "set" of the brand belongs in NB and that the operator can
move rows across that line with their links intact. Claim numbers are the
merged flow's (`flagship-colour-is-a-parallel-both-ways`, retired by the
NEO-312 split):

| claim | proved by | steps |
| -- | -- | -- |
| 1 — Sync Sets mints nothing; the review files it | `tests/setup.spec.ts` (its 2026 Bowman step, last in the seed) | 1 |
| 2–3 — Insert reconcile, Group Parallels, re-sync; the parallel build | `tests/set-selector/bowman-insert-grouping-builds-parallels.spec.ts` | 2–9 |
| 4–5 — `Blue` pairs, Promote / Make parallel of; Make insert of… | `tests/set-selector/bowman-sportlots-links-move-between-set-parallel-insert.spec.ts` | 10–14 |
| 9 — a moved SportLots link is never re-created by a later sync (NEO-312) | `tests/set-selector/bowman-sportlots-links-move-between-set-parallel-insert.spec.ts` | 15–16 |
| 10 — only an insert opens the sub-variants column: none under `Parallel`'s `Blue`, `Sync Sub-Variants` under `Insert`'s `All-America Game Autos` (NEO-334; reads only, no new write) | `tests/set-selector/bowman-sportlots-links-move-between-set-parallel-insert.spec.ts` | 10, 16 |

1. Sync Sets mints no SportLots-only set; the brand's review (the pill `N
   SportLots sets to sort`) files them — every row under Bowman › Parallel in
   bulk, `Bowman Sterling` as its own set, `All-America Game Autos` under
   Bowman › Insert (NEO-306).
2. Bowman › Insert — populated by the review, so an explicit `Sync Inserts` —
   reconciles BSC's inserts with SportLots'; `Anime` and its parallels become
   NB sets ("Make its own set", "Keep all"); Group Parallels nests `Anime
   Kanji` under `Anime` — over 200 suggestions, so the one Save goes out as
   several calls and a re-open finds nothing left to suggest (NEO-308); a
   second `Sync Inserts` leaves the grouped rows alone (NEO-293, NEO-300).
3. The promoted `Anime Kanji` keeps its BSC id as a working source and is
   built from its insert (NEO-312): Fetch from Marketplaces on `Anime` saves
   cards, the save builds all 4 of `Anime`'s parallels one at a time,
   `Anime Kanji` is built with cards, and its chip — tagged as a
   BSC variant, no "Needs re-mapping" — counts > 0 cards through its own slot
   (NEO-293, NEO-312).
4. Bowman › Parallel's sync pairs BSC's `Blue` with the review's `Blue`;
   `Promote to set` and `Make parallel of…` move that link out and back
   (NEO-305).
5. `Make insert of…` moves the review's Parallel row `All-America Game Autos
   Red Ink` under Bowman › Insert › `All-America Game Autos` as the new
   parallel `Red Ink` (NEO-306).

**History.** It was two flows until 2026-09-25, merged into one (owner
decision, NEO-306) because an insert column auto-syncs only when EMPTY and
whichever wrote Bowman › Insert first broke the other's first reconcile. The
one flow reached 570 s of the 600 s kill (CI run 36524859308), and NEO-312
split it again along lines that are measured disjoint (below), with the one
brand-wide write both halves need — Sync Sets and the review — moved into
the seed, where nothing races it. Every assertion of the merged flow is kept.

**Why the split is safe — the write sets, measured (code read + CI Convex
logs, NEO-312).** Flows run concurrently against one preview and set data is
global, so each brand- or set-wide write was checked for the rows it touches
and for a client-side plan that could go stale under the other flow:

| write | rows it touches | a stale client plan? |
| -- | -- | -- |
| SportLots review save (setup) | the brand's review rows → one set + rows under the Insert / Parallel types (`slSetReview.ts:653`, logged `sl_review_rows_under_type`: insert 1, parallel 40 + 39) | n/a — the seed runs alone |
| Sync Inserts reconcile (inserts flow, STEPS 2, 5b) | the Insert type's own children only, read fresh at save (`setReconciliation.ts:1505`); changed fields only, never `children` of a child (`:2127-2129`); the type's `children` by UNION (`:2137-2146`); rows elsewhere in the type's subtree HELD, never written (`selectorSyncStore.ts:487-517`; logged `selector_sync_held_elsewhere`, level `insert`) | seeds every existing insert into Ready (`setReconciliation.ts:1397-1398`) — re-stores `All-America Game Autos` as is; a parallel the links flow adds under it is a CHILD, never named, so it survives |
| Group Parallels Accept all + Save (inserts flow, STEP 4) | only the rows the plan changed (`ParallelGroupingModal.tsx:331-357`); every parent's `children` re-read and unioned at save (`selectorOptions.ts:7384-7392`); one variant type's tree (`selectorOptions.ts:7183`) | none: `Red Ink`, if present, is a parallel with an unchanged placement, so it is not in the diff |
| Sync Parallels reconcile (links flow, STEPS 10 and 15) | the Parallel type's own children (same store) | **seeds the Red Ink source row into Ready**; a Make insert of… landing while it is open would make the save re-create that row (`existingId` matched against siblings only, `setReconciliation.ts:1379-1385`; held-elsewhere is per variant type, `selectorSyncStore.ts:504-517`) — **so STEPS 10 and 14 are one flow, in that order**. **STEP 15 is the regression proof of the production bug this path had**: after Make insert of…, a plain later `Sync Parallels` re-created the moved row (the single-platform store auto-stored it; the two-sided reconcile auto-paired it into Ready). NEO-312 makes the save withhold any id a row anywhere in the set or brand already holds, and the client stop auto-storing or auto-pairing a held id |
| Promote to set (links flow, STEP 11) | `Blue` (`setParallelConversion.ts:1139`), a minted set + Base under the brand (`:1091`) | none outside the links flow |
| Make parallel of… (links flow, STEP 12) | `Blue` (`setParallelConversion.ts:702`), deletes the empty set + Base (`:785-786`) | none outside the links flow |
| Make insert of… (links flow, STEP 14) | a NEW parallel under `All-America Game Autos` (`setInsertConversion.ts:1170` → `:970-985`, parent `children` by union), the source row deleted (`:1256`) | its `Where it goes` list is a reactive query over the Insert type's inserts (`MakeInsertControl.tsx:230`) that the inserts flow's saves reshape — a UI race, not a data one: the pick is retried once, result-keyed |

The inserts flow never writes the Parallel type, `Blue`, a set, or the
review's `All-America Game Autos` subtree; the links flow never writes an
insert-level row. The Sets column gains `Bowman Blue` for the seconds
between STEPS 11 and 12; the inserts flow selects `Bowman` by its exact
name under the column's search box, so a transient sibling set is inert.

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
| drills | setup's drill is COLD on a fresh preview; under the pause it hand-makes the manufacturer row `Bowman` (the cold util's guarded create) and then selects the set once to sync its Variant Types. The two flows' drills are WARM and pass no `CREATE_MANUFACTURER` — setup is that row's sole writer, and two concurrent guarded creates could mint it twice |
| review (live) | bulk: every row → Bowman › `Parallel` (picking Bowman force-syncs its Variant Types inside the dialog, additive); row tick + bulk: `All-America Game Autos` → Bowman › `Insert`; per row: `Bowman Sterling` → its own set; saved at the 7000 bar |
| Insert reconcile (live) | `Sync Inserts` (the column holds the review's row); filters Ready and BSC to "Anime"; `Anime` its own set when Pending; the BSC filter cleared, then "Keep all" on the WHOLE BSC column — every pending BSC insert its own set (NEO-308; it was the "Anime"-filtered column before); **saves every Ready set** (the review's row comes back restored) |
| grouping | Group Parallels → `Accept all suggestions (N)` with N ≥ 201, asserted → `Save N changes` → the modal closes within 7000 (the save cut into ≤200-entry calls, NEO-308); every prefix pair nests, `Anime Kanji` and the other Anime parallels under `Anime`; a re-open reads `No changes yet` with no Accept-all button (every chunk landed) and leaves through Cancel |
| re-sync (NEO-300) | "Sync Inserts" again; live the reconcile re-opens and is saved with no edits, paused the single-platform store runs; both say "N already grouped as parallels. Leaving those be." and do not re-create a grouped row as an insert |
| fetch | on the INSERT `Anime` (NEO-312 — a parallel's checklist is built from its insert, never fetched): the pairing dialog when SportLots paired a set with it, the one-marketplace path otherwise (always, paused); the review is drained with "Skip remaining names" (no players created) |
| parallel build (NEO-312) | the save starts the automatic build of `Anime`'s parallels in `Anime`'s own child order, one live fetch per parallel on the sides THAT parallel holds, and the flow lets it run to the end — all 4 built (CI 36516143308: 7 / 29 / 29 / 29 cards, ~3s for the run); the finished heading `Anime parallels — N built` and `Anime Kanji — Built N cards` are asserted; Stop is never pressed (unit-tested); `Anime Kanji`'s BSC chip then counts > 0 cards through its own slot and its Sync slot reads `Rebuild from Anime` |
| Parallel reconcile (live) | `Sync Parallels` (the column holds the review's rows); BSC's `Blue` lands on the review's restored `Blue` row (attached by id, the NEO-306 reconcile fix); every Ready set saved |
| promote / fold | `Blue`'s SportLots link → the set `Bowman Blue` (the row stays: BSC holds it) → `Make parallel of…` folds it back onto `Blue` |
| make insert | Bowman › Parallel › `All-America Game Autos Red Ink` → Bowman › Insert › `All-America Game Autos` › new parallel `Red Ink` (the dialog's `Find an insert` filter used when the list is over 12) |
| re-sync after the move (NEO-312, claim 9) | STEP 15: `Sync Parallels` again on Bowman › Parallel (live: the reconcile opens and every Ready set is saved; paused: the single-platform store, `Stored N variants (single platform)`), then `All-America Game Autos Red Ink` searched in the column — `No matches found` (the positive) and the row absent. STEP 16 (live): Bowman › Insert › `All-America Game Autos` › `Red Ink`, its SportLots chip (`Remove …Red Ink`) pressed, the confirm reads `Detach SportLots "…Red Ink"? …`, Cancel — the link is still on the moved row. The Inserts column is read in either shape (one row before the inserts flow's reconcile, ~140 after) |
| paused | no review, no pill; Insert and Parallel fill from BSC alone; grouping, re-sync, chip and one-marketplace fetch as live; `Blue` offers no Promote, and the SportLots-only claims have no paused form |

**What the three leave behind** (fresh-only; the scripted reset removes it
all at the head of every run):

| | |
| -- | -- |
| sets | `Bowman Sterling` (+ Base holding its SportLots id); no `Bowman Blue` |
| Insert | every set the Insert reconcile saved, with the ids the sync gave it — every pending BSC insert among them (NEO-308); every word-prefix pair nested by Accept All (`Anime Kanji` a parallel under `Anime`, its BSC slot tagged `variantName`); `All-America Game Autos` with the parallel `Red Ink` |
| Parallel | every SportLots-only colour the review filed, plus BSC's parallels; `Blue` with BSC + SportLots links; NO `All-America Game Autos Red Ink` (moved by STEP 14, and a second Parallels sync, STEP 15, did not bring it back) |
| `Anime` checklist | COMMITTED, every card from BSC (plus SportLots' when paired); its unknown names SKIPPED, so no players or teams are minted |
| `Anime`'s parallels | all 4 built as copies of `Anime`'s cards (NEO-312), each copy linked to its parallel's OWN BSC (and SportLots, when paired) card; nothing pressed `Build`/`Rebuild` on a parallel row |
| never touched | Base, any other checklist, any card edit |

**One sole writer per row, fresh-only.** No other flow may drill into 2026
Bowman. A local re-run of either Bowman flow needs a fresh seed (reset +
`tests/setup.spec.ts`): the inserts flow's first reconcile and the links flow's
Promote both assume the seed's state.

**NEO-308 (the chunked Group Parallels save) is proven HERE, not in a flow of
its own.** Owner's call: live, on 2026 Bowman ("it has plenty"), not a seed
and not UI-built rows. It lives in the inserts flow, the sole writer of
Bowman › Insert's BSC inserts: Bowman › Insert only exists once that flow's
reconcile has run, the queue orders nothing, and the grouping it would save
is the one STEP 4 there saves. Re-runnability is the flow's
existing one — `tests/setup.spec.ts`'s reset at the head of every run; nothing
undoes a grouping inside the run, and nothing needs to:

* there is no bulk ungroup — a demotion is one `✕` or one `Select <row>`
  tick per row (maestro-web holds no Shift, so no range select), ~2s a tap,
  so undoing 200+ rows is 400s+ of taps;
* a re-sync leaves grouped rows alone by design (NEO-300);
* the only other reset is the scripted one (R7: never a flow step).

What NEO-308 needed from the fixture: a plan PAST 200 entries. Kept to the
"Anime" family, STEP 4 read `Accept all suggestions (130)` / `Save 130
changes` (green CI 36324889198; 141 in 35948573036) — one call, proving
nothing. STEP 2 now keeps the WHOLE pending BSC column (~140 of the 297
items BSC answers for Bowman's insert level, same run), the shape the
operator met on production (`Accept all suggestions (212)` → `Save 259
changes` → refused). ⚠️ NOT YET MEASURED: the resulting suggestion count
(STEP 4 asserts ≥ 201 and fails by name below it), the ~290-set reconcile
save and the 200+-entry grouping save against the 7000 bar, and whether BSC
lists a name the review already filed under Insert (a second
`All-America Game Autos` would make STEP 14's `Add to …` ambiguous).
Record them here after the first run.

**MEASURED 2026-09-25 on PR #288's Convex preview** (local Vite → the
preview; the review read out of `slSetReviews`, the rest from the flow's own
step timings):

* **the review: 81 SportLots-only names** (the pill read 81 and `Apply to 81
  selected`), brand-stripped, in folded order: `All-America Game Autos`,
  `All-America Game Autos Red Ink`, `Base Set`, the colours (`Black` …
  `Yellow Pattern`, 26), `Bowman Logo Pattern`, the `Bowman Sterling` family
  (12), `Prospects` (33), `Printing Plates …` (4), `Rookies and Veterans
  Autos` (8). **There is no bare `All-America`** (the first guess): the row
  filed as its own set is `Bowman Sterling`, a product of its own, which
  keeps its name as the set (`candidateDefaultName` adds no prefix to a
  label that already starts with the brand). So the save files **1 set, 79
  parallels, 1 insert**.
* Bowman's variant types: `Base`, `Insert`, `Parallel` — the names both old
  flows' green runs already read.
* the review save: the toast landed **0.71s** after the Save tap's ~2s — well
  inside 7000;
* the in-dialog Variant Types sync (forced, BSC + SportLots): **7.8s** against
  its 60000 marketplace ceiling;
* the Inserts reconcile opened in 7.3s and saved in 1.1s; the re-sync opened
  in 6.8s and saved in 1.0s;
* the checklist's own writes: the Match Cards close **1.06s** and `Saved N
  cards` **0.36s** after Confirm & Save — both now on the 7000 bar (they were
  60000 by inheritance);
* STEP 10's pairing landed: the Parallels column lists `Blue` with both `SL`
  and `BSC` badges (the NEO-306 reconcile fix attaching BSC's `Blue` to the
  review's row by id).
* still to read on the next run: STEP 14 (the Make insert of… path toast and
  whether "Where it goes" crossed 12 choices).

**Two traps the first runs found** (both fixed in the flow):
* the flow's `name:` was 417 bytes; Maestro names a debug directory after it
  and Linux refuses a path component over 255 bytes, so CI run 36164550212
  lost the flow before its first command (`File name too long`);
* the review's picker LISTS carry a React `useId` DOM id, which shadows their
  aria-label as Maestro's resource-id — the flow takes each list's option
  nearest below its trigger instead of naming the list.

`ensureSelectorOptions` has no "already syncing" guard; with one flow on the
brand-year nothing races it any more.

### Baseball → 2025 — the NEO-333 dual-team fixture (Bowman Draft › Insert › Prospect Dual Autographs)

`tests/set-selector/checklist-dual-team-card-links-both-teams.spec.ts` proves NEO-333 live: a BSC
team value naming two clubs ("Boston Red Sox, Detroit Tigers") becomes two
team links, never one combined team. The owner first named 2026 Bowman ›
Insert › `Draft Pick Pairings Autographs`, the set he hit the bug on; that
insert exists only in 2026 Bowman (16 cards), whose insert level is
`bowman-insert-grouping-builds-parallels`' alone and only exists once that
flow's reconcile has run, so he chose an uncontested set instead (option B,
2026-10-10).

**The set.** Baseball → 2025 → Bowman › `Bowman Draft` › Insert › `Prospect
Dual Autographs`: per the published checklist, 14 cards, each signed by two
draftees, 10 from two organisations (PDA-BW is the same Bazzana / Willits,
Guardians / Nationals pair as 2026's DPPA-BWI). No flow opened 2025 before
this one.

**The target card: PDA-WW**, Kyson Witherspoon (Boston Red Sox) / Malachi
Witherspoon (Detroit Tigers).
* It is the LAST row in natural card-number order, and the checklist's
  react-virtuoso list opens at its end and renders only its ~440px window
  plus overscan. So the last row is the one row certain to be in the DOM; a
  card in the first half of a 14-row list may not be.
* Each club is ONE Baseball row in the reference catalogue, current and
  open-ended, with no alias (the only other "Detroit Tigers" is a Football
  row, and team resolution is per sport), so neither half raises a team
  step.
* No other card in the set carries either club, so the pair alone
  identifies the row.

**Why the whole year.** The cold drill's Sets sync is year-wide on BSC's
side: it files every 2025 BSC set under the year's brands. So the flow owns
Baseball → 2025 the way `known-brand-files-set-…` owns 1990 and
`brand-via-all-brands-…` owns Hockey 1997. No other flow may drill into
2025. SportLots' Bowman review (the `N SportLots sets to sort` pill) is
left unsaved, and nothing reads it.

**What it writes.** Everything the cold drill syncs (Manufacturers, Sets,
`Bowman Draft`'s Variant Types), every Ready set of the Insert reconcile
(the target family made its own sets by "Keep all" on the BSC column
filtered to its name), the insert's committed `cardChecklist` rows, and,
only if the wizard opens, per-set `entityReviewSkips` for the names it
skips. It creates no player,
team or league, and it renames, moves or deletes nothing. Fresh-only: a
re-run on the same preview finds the Insert column saved and fails at the
reconcile gate, by name.

**Which names are new on a fresh preview: none** (measured 2026-10-12,
NEO-330, read-only against a preview holding the catalogue). The catalogue
is a prod snapshot and prod has built this set:
* Players: all 21 draftees are single Baseball rows, and
  `players.resolveNameForReview` (set year 2025) answers each with one
  `playerId`.
* Teams: all 16 clubs BSC names resolve to exactly one row for 2025, BSC's
  bare "Athletics" on PDA-DM included. Every club with older same-name eras
  (Milwaukee Brewers, Washington Nationals, Baltimore Orioles, Cincinnati
  Reds) has one open-ended row covering 2025. No comma-joined value on the
  set names a team or an alias.
So the fetch commits straight to `Saved 14 cards` with no wizard. An
unsplit value would resolve to nothing and open the wizard on a comma-joined
`New Team:` step, which is what the flow's STEP 5 checks for. The wizard
branch stays for a catalogue refresh that drops a name or a SportLots set
pairing with the insert; it skips every staged name. Before the catalogue
all 21 draftees were unknown, their live lookups took 34.8 s to settle, and
one staged a Wikidata career team (`Sydney Blue Sox`), skipped.

**No recorded lookups are needed.** Nothing is staged on the catalogue, so
nothing is looked up. Should a refresh stage names again, a name absent from
the recording goes live (README → "Enrichment fixtures"); the flow decides
nothing that depends on a lookup's answer.

**Verified 2026-10-12** against BSC's public catalog facets and #316's green
CI run: the set is `Bowman Draft` under the `Bowman` row, the insert's
variantName is `Prospect Dual Autographs` (14 cards, PDA-AD … PDA-WW), and
PDA-WW's BSC teams are Detroit Tigers and Boston Red Sox. In that run
SportLots paired no set with the insert (Pending → Keep all), so the fetch
took the one-marketplace path.

### Football → 2014 — the NEO-343 team-leader fixture (Topps › Base) ✅ APPROVED by Jason 2026-10-13

Proposed 2026-10-13 for NEO-343 (BSC's "<Team> TL" team-leader cards) and
NEO-344 (bare conflict values, and the picked value is the one saved).
Approved by Jason the same day, with the flow's full shape: the fetch, no
team-leader conflicts, then the pick, the save and the read-back.

**Why this set.** BSC writes a team-leader card as `<Team> TL` only on Topps'
flagship football bases (2013, 2014, 2015) and their 2013 Mini / 2015
Oversized reprints, every one 440–500 cards; no small set carries one (BSC's
public catalog facets, 2026-10-13; a `<Team> TL` search across baseball,
basketball and hockey finds only 1990 SkyBox and 1974 O-Pee-Chee, both ~400).
2014 is the one whose SportLots rows name the card `<Team>` (`#110 Buffalo
Bills`), so the pair rests on the BSC `TL` parse alone. 2013's SportLots rows
read `<Team> Team`; the SportLots adapter parses those to the bare team too
(same PR), and that is covered by the adapters' unit tests only. A 2013 E2E
would need a second real year (its own cold drill, Base mapping and ~1,000-row
two-sided fetch, the same ~4–5 minutes as below) and was not added.

**What the catalogues say (read 2026-10-13, public endpoints, NOT measured in
the app).**

| | |
| -- | -- |
| BSC base items | 554: 440 cards plus SP photo variations `1b`–`69b`, `365b`, and `442` (Jordan Lynch, SP, which SportLots does not list) |
| team-leader cards | 32: `#6a`, `38a`, `39a`, `68a`, `73`, `94`, `99`, `101`, `105`, `108`, `110`, `116`, `130`, `146`, `158`, `166`, `182`, `191`, `193`, `204`, `212`, `213`, `221`, `226`, `236`, `251`, `268`, `271`, `298`, `299`, `314`, `327` |
| SportLots `2014 Topps Base Set` | 447 public rows: #1–#440 plus variations `#9 [Running]`, `#25 [Red jersey]`, `#431 [Leaning left]` and `[Retail Factory Set]` on #356, #367, #374, #429, #434 |
| pre-fix header (prod, 2026-10-13) | 40 name conflicts, 38 player conflicts |
| expected natural conflicts after the fix | a handful (#72 Perry Riley / Riley Jr., #247 Robert Griffin III / Robert Griffin, #257 Super Bowl XLVIII / Seattle Seahawks Sb Champions, #405 George Atkinson III / George Atkinson, by name comparison) |

**What the flow relies on, to pin on its first run:** the dialog's matched
list opens on `#1a … #6a` with #6a (New England Patriots) the sixth row and
matched; `#442` is BSC-only; at least one SportLots-only card heads the
SportLots column; both counts land under 32; the picker's first-ranked
candidate on each side is this set's Base (`2014 Topps Base Set` on
SportLots); what the review wizard stages (up to 32 team names reported as
players under the TC rule, plus non-person rows). Record the measured counts
and the wall-clock here.

**Cost (estimate, unmeasured).** Cold drill to the year ~30 s, Sets ~20 s,
Variant Types ~15 s, Base picker ~10 s (`checklist-one-marketplace-…`'s
measured cold path), a 554 + 447 card two-sided fetch ~60–90 s (Topps Big
League's 310 cards took ~40 s), the dialog steps ~40 s, the commit with a
skipped wizard ~20–60 s, the re-entry and read-back ~30 s: **~4–5 minutes**,
inside the 600 s kill but among the suite's longest flows.

**Sole writer of Football → 2014.** No other flow opens the year. The flow
commits a deliberately mis-paired card (#442), so nothing else may read this
set's cards.

### The one sanctioned read-only visitor

`checklist-pairing-dialog-cancel` (NEO-137, extended by NEO-189) syncs
`Insert → Future Stars` on the real anchor and then **cancels** the card-pairing
dialog. Cancel returns before `commitCardChecklist`, so nothing is written and
the set is left exactly as `tests/setup.spec.ts` provisioned it — it reads, it does not
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

No flow other than `tests/setup.spec.ts` may add, edit, or delete cards, players, teams,
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
end-to-end path — STEP 6 of `tests/set-selector/inserts-1996-score-one-nb-set-two-bsc-sources.spec.ts`,
which opens the wizard on a genuine cold two-source fetch and now also covers
decide → Cancel (Esc) → "Discard 1 decision?" → keep, and the Enter commit.

Do not re-create them **the way they were written**: a marketplace-free subtree
cannot produce an unknown name any more.

**NEO-248 brought the coverage back on a REAL set.** The wizard opens only on
names a marketplace fetch returned that NeonBinder does not already hold, and
only **BSC** returns names at all — so the fixture has to be a real,
BSC-listed set, synced through the real hierarchy. It is
`Baseball → 2024 → Topps → Topps Big League → Base`; read its section below
before touching any of these three.

| flow | what it owns |
|---|---|
| `checklist-wizard-back-to-matching-resumes-decisions` | "Back to Match Cards" parks the review; re-confirming resumes the SAME batch with its decisions |
| `checklist-wizard-link-to-existing-player` | "Link to Existing" resolves onto a roster player instead of minting a duplicate |
| `checklist-wizard-career-team-entry` | the inline career-team mini-form on a player row, and the decision it feeds |

all sharing `fetchChecklistToWizard`, and all three
READ-ONLY (Cancel → Discard). A fourth, `checklist-wizard-skip-not-a-person`
(the per-row skip, and "Skip remaining names" deciding every row that is left,
lookups included), read this set until NEO-330: with the reference catalogue
loaded, Big League stages too few names for its footer skip, so it moved to
its own BSC-only set, Fort Worth Fire CHL (Jason, 2026-10-10; see "The 1995
minor-league hockey wizard fixtures"). It is still read-only.

Three SIBLING flows cover the **commit** side — what a decision is worth once it
is saved — and each gets its own real set so it can write without racing
anything:

| flow | fixture |
|---|---|
| `checklist-wizard-skip-commits-and-unskip` | Hockey 1995 Tulsa Oilers CHL (NEO-330; Topps Chicago Cubs before) |
| `checklist-wizard-career-team-commits` | Hockey 1995 Memphis RiverKings CHL (NEO-330; Topps Baltimore Orioles before) |
| `checklist-wizard-link-commits` | Hockey 1995 San Antonio Iguanas CHL (NEO-330; Topps Brooklyn Collection before) |
| `checklist-wizard-link-team-saves-alias` | Baseball 1996 Line Up Venezuelan Winter League (NEO-330; Topps MLB at Rickwood Field before) — one-sided, see its own section |

See "The 1995 minor-league hockey wizard fixtures" below (and, for the history,
"The three COMMITTING entity-review fixtures"), and "The TEAM-link alias
fixture" after the one-marketplace section.

**They no longer own a custom-set prefix.** `wbr-`, `skp-`, `lce-` and `cte-`
are retired along with `fcd-` and `kod-`: these flows create nothing. The
discard confirm and the Enter commit live in STEP 6 of
`tests/set-selector/inserts-1996-score-one-nb-set-two-bsc-sources.spec.ts`.

### The 1995 minor-league hockey wizard fixtures — one set per flow (NEO-330) ✅ APPROVED by Jason 2026-10-10

Every CI preview now loads prod's reference catalogue (README → "A reference
catalogue is on every CI preview"), and the wizard stages only names the
deployment does not know. The three MLB team sets below and Topps Big League
no longer stage enough: CI run 38063558063 committed Cubs and Orioles straight
through with no wizard, Brooklyn's walk ran out of player rows, and
`checklist-wizard-skip-not-a-person` found nothing left for its footer skip.
Jason moved four flows onto four of the 1995 minor-league hockey spares listed
under the one-marketplace fixture. Each set is BSC-only and filed under the
year's `Unknown` row; Hockey's catalogue players are NHL-only, so their
rosters stay unknown.

| flow | fixture | role | cards | measured unknowns (at open → settled) |
|---|---|---|---|---|
| `checklist-wizard-skip-commits-and-unskip` | Hockey → 1995 → Unknown → **Tulsa Oilers CHL** | sole writer (commits; every name skipped) | 18 | **16 players, 0 teams** → 19 rows (three Wikidata career clubs staged, e.g. `New Team: Columbus Chill`) |
| `checklist-wizard-career-team-commits` | Hockey → 1995 → Unknown → **Memphis RiverKings CHL** | sole writer (commits; one player + one hand-staged team) | 18 | **15 players, 0 teams** → 15 |
| `checklist-wizard-link-commits` | Hockey → 1995 → Unknown → **San Antonio Iguanas CHL** | sole writer (commits; two links) | 18 | **16 players, 0 teams** → 16 |
| `checklist-wizard-skip-not-a-person` | Hockey → 1995 → Unknown → **Fort Worth Fire CHL** | sole READER (Cancel → Discard) | 18 | **16 players, 0 teams** → 16 |

**How measured.** A throwaway probe per set (never committed) on PR #314's
preview, 2026-10-10, with the catalogue loaded and SportLots live: drill
Hockey → 1995 → the All Brands view, pick the set, cancel the base picker,
fetch on BSC, read the wizard (`Kept all N cards from BSC … N new players + M
new teams need confirmation`, the header, `Add remaining players as new (P)` and
`Skip remaining names (R)` once every lookup had settled), then Cancel —
nothing saved. Each probe left only the set's synced `Base` variant type
behind. Re-measure after every catalogue refresh: a bundle that gains these
rosters drains the fixtures. **A set an operator builds in PRODUCTION becomes
known on the next refresh**: the bundle is a copy of prod's players and teams,
so the moment someone builds one of these sets (or a set sharing its roster)
in prod, the next bundle carries its names and the fixture stops staging
them. The refresh procedure in `docs/operations/neo330-reference-seed.md`
re-measures every wizard fixture for exactly this reason.

**The path.** All four reach the wizard through
`fetchOneMarketplaceSetChecklistToWizard` (support/wizard.ts) (extracted from
`checklist-wizard-link-team-saves-alias`'s inline path; its drill, set pick and
cancelled picker are `openOneMarketplaceSetBase`, which a flow
re-entering a set it committed calls again): the cold drill util
with `MANUFACTURER: "All Brands"`, the set picked from the view, the base
picker CANCELLED (BSC answers; SportLots' 1995 catalogue is offered and
declined), the fetch takes the NEO-255 solo path ("Kept all 18 cards from
BSC") and opens the review with no pairing session behind it. Because the Base
stays unmapped on SportLots, every later drill would auto-open the picker
again; none happens, since each flow is its set's only visitor.

**Link target.** `checklist-wizard-link-commits` links one row to **Wayne
Gretzky**, a reference-catalogue Hockey player. Verified read-only on the
preview: exactly one `players` row "Wayne Gretzky" (`gretzky wayne`) under
Hockey; the search for "Gretzky" also returns Brent Gretzky, a different
accessible name.

**Shared columns, concurrent first syncs — measured, nothing added to the
seed.** These four flows and `checklist-one-marketplace-skips-match-dialog`
all drill Hockey → 1995 → the All Brands view, cold, on parallel runners, and
`ensureSelectorOptions` has no in-flight guard (a column that opens empty
fires it; the action skips only when the column is already populated). Fired
FIVE `ensureSelectorOptions` calls at once, as five different E2E admin
accounts, on a cold Hockey year of the same preview (1994, which no flow
uses), first at the manufacturer level and then at the year-wide Sets level
the view opens: all ten ran (`ran: true, reason: synced`), each Sets sync took
~11s instead of ~6s, and the result held **no duplicate manufacturer row, one
`Unknown` row, no duplicate set (by name under a parent, by name across the
year, or by BSC or SportLots id) and no leftover sync-status row**. Every
store is an id-keyed mutation, so concurrent writers serialise on Convex's
transactions. The cost of a race is a doubled marketplace round-trip, never
a doubled row, so the columns are not pre-synced in `tests/setup.spec.ts` (whose time
every PR pays), and each flow keeps paying its own cold drill.

**Drain and re-runs.** The three writers commit, so after one run their sets
hold cards and re-sync instead (no review): a local re-run fails at the util's
`No cards in this checklist yet.` precondition until the preview is
re-seeded. The reader discards, so it can re-run; a red attempt leaves its
review batch, which the next fetch by the same account RESUMES (`N of M
reviewed`), so discard it before re-running locally. CI does not retry flows
(`MAESTRO_FLOW_RETRIES` defaults to 1) and reseeds every run.

**Remaining spares** (same shape, untouched): `Dayton Bombers ECHL`, `Dunkin
Donuts Portland Pirates AHL`, `Halifax Mooseheads QMJHL`. Swapping one in needs
Jason's approval and a probe like the one above.

### The three COMMITTING entity-review fixtures — one set per flow (NEO-248) — RETIRED by NEO-330

> **History.** These three sets are no longer used by any flow: NEO-330 moved
> their flows onto the 1995 minor-league hockey sets above, because the
> reference catalogue knows their rosters. Kept for the measurements and the
> two-sided mapping rule, which still governs `fetchChecklistToWizard`.

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
what `drillToBaseVariant` picks. Measured: `Baltimore Orioles`,
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
re-run needs a fresh seed — rerun `npm run test:e2e:seed`.

#### Why these sets, specifically

* **Team sets have unknown players.** `tests/setup.spec.ts` only ever creates the ~494
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

`tests/setup.spec.ts` deliberately provisions NOTHING for these three. Doing so cost
~2 minutes of SERIAL seed time and pushed the seed past its 600s wall
(run 34048184342); the seed runs once, before every runner starts, so anything
added there taxes every PR.

Instead each flow provisions its own set on its own runner, in parallel.
`fetchChecklistToWizard` (support/wizard.ts) already handles the cold
first-time path with no extra step: the warm drill's closing
`visible: "Base"` (60s) covers the cold variant-type sync, and
`drillToBaseVariant` (support/set-builder.ts) has a `when: visible "Select Base Set"` branch
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
more, because Big League is now the wizard fixture and `tests/setup.spec.ts` maps its
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
> (`MANUFACTURER: "All Brands"` on `drillToColdManufacturer`, which taps
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
exactly one flow, `tests/set-selector/checklist-one-marketplace-skips-match-dialog.spec.ts`, which
fetches and COMMITS its 25-card checklist. Everything below was measured live
on PR #242's Convex preview (`fine-egret-808`) on 2026-09-07, so the decision
can be made on numbers rather than on a guess.

`tests/set-selector/checklist-one-marketplace-skips-match-dialog.spec.ts` proves the NEO-255 rule:
when exactly ONE marketplace is **attached** to a set, "Sync card checklist"
skips the Match Cards dialog, keeps every fetched card as a single-marketplace
card ("BSC only"), and goes straight to the entity review with **no "Back to
matching"**.

**There is currently ZERO one-sided coverage.** Every flow in the suite that
reaches the pairing dialog — `tests/setup.spec.ts` ×3, `checklist-pairing-dialog-cancel`,
`fetchChecklistToWizard` and its four `checklist-wizard-*`
callers, the three `*-commits` siblings, `inserts-1996-score` — is on a set with
BOTH sides attached. They cover the ≥2 half of the rule, which this ticket does
not change; none of them can express the =1 half.

| | |
| -- | -- |
| ancestors | `Hockey → 1995 → Unknown` (reached through the All Brands view; the row was called All Brands before NEO-237) |
| set | **Roanoke Express ECHL** |
| variant type | `Base` (the set's ONLY variant type — clean sync, BSC pill, no reconcile dialog) |
| checklist | **25 cards**, all BSC-only — FETCHED and **COMMITTED** by the flow |
| unknown names | **25 — all players, 0 teams** ("25 new players + 0 new teams need confirmation", "0 of 25 reviewed" when measured; since NEO-335 Phase 2 the banner reads "25 names need a look before this saves." and the header "Step 1 of …"), stable for 27s after the wizard opened |
| Base mapping | left **UNMAPPED** on SportLots, on purpose — the flow cancels the picker |
| writer | `tests/set-selector/checklist-one-marketplace-skips-match-dialog.spec.ts`, **sole writer** |
| pre-synced by `tests/setup.spec.ts` | **no** — the flow pays its own cold syncs, on its own runner, in parallel (the NEO-248 rule: nothing goes in the seed) |

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
   `Cancel (Esc)` and — the point of the ticket — **no `Back to Match Cards`**.
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
    (with a further ~15s tail as the attention count climbs to 25 — gone
    since NEO-335: the commit stamps every card whose fetch-time lookup
    answered, so the count is whole at "Saved", and the flow now asserts it
    within R5's 7s). The Maestro
    run reached the base picker's cancel at **t≈95s** including sign-in, so the
    whole flow should land near **~2 minutes** — comfortably inside the budget,
    and in the same band as `checklist-pairing-dialog-cancel` (2m29s, measured
    on the same preview the same evening).

#### What STEPs 5, 6, 6b, 6c, 7, 9 and 10 do, and what that writes (NEO-335)

Past its names the review now walks a TEAMS step of its own (NEO-335 Phase 2:
subtitle `Cards with no team`, intro `Pick a team for each card, or leave it
for later.`, footer `Next (Enter)`) before the Save step (`Ready to save`,
`Save N cards?`, Confirm & Save). This fixture is a true blank: BSC lists no
team for any of the 25, so every card is on the teams step (the same 25 the
old attention count climbed to). The step prints no count; the header's
`Step x of y` is the only number.

- **STEP 5** asserts the sitting opens at `Step 1 of …`.
- **STEP 6** creates the first player the wizard presents ("Add as New
  Player"; header `New player`), with ONE hand-staged career team
  `RXT<token>` (1994–1996), decided "Add as New Team" in its own New Team step
  (header `New team`). Every other name is skipped. Whichever Roanoke name
  that is, no other flow touches it.
- **STEP 6b** reads the teams step: that player's card is a player line with
  `RXT<token>` CHECKED by default. Since Phase 2 a career pre-fills only when
  EXACTLY ONE of its teams covers `[setYear-1, setYear]` (C2,
  `careerTeamVerdict`); the set year is 1995, the window `[1994, 1995]`, and
  the 1994–1996 stint covers it — the only one that can (Wikidata career teams
  met on the way are skipped, and a skipped team string is not a team). The
  other 24 cards have no players (their names were skipped), so they share
  ONE line, `Cards with no players (24)`, on `Leave for later`. Its card list
  (`#NNO, #NNO, #NNO +21 · 24 cards`) opens; card 1 takes
  `Just this card… — #…` → `No team on this card`; card 2 takes
  `Just this card…` → `Other team…` → the search field (`Team name to find`)
  → `No matches.` → Enter → the New Team dialog → `Create team RXO<token>T`,
  which joins that card selected; the line itself stays on `Leave for later`.
- **STEP 6c** leaves with `Next (Enter)` and asserts the Save step is
  `Step y of y` (y read on the teams step) and `Save 25 cards?`.
- **STEP 7** asserts the pill reads `22 need you` within 7s of
  `Saved 25 cards.` (25 − the "no team" card − the RXO card − the pre-filled
  card; one card per player here, measurement 5).
- **STEP 9** walks the drawer's `Next card` from `NB272-…` (it sorts first)
  to the two cards with a team chip, in whichever order the checklist shows
  them, and asserts `Remove team RXT<token>` on one and
  `Remove team RXO<token>T` on the other.
- **STEP 10** re-syncs. The content review always opens (the pre-filled and
  RXO cards store a team BSC does not list; skipped cards store no player
  link against an incoming name), and the flow presses `Skip changes`. With
  no names left the review opens TEAMS-ONLY — `Step 1 of 2`,
  `Cards with no team`, no bulk links, ONE line `Cards with no players (22)`
  on `Leave for later` (exactly the cards left for later), the pre-filled card
  not asked again —
  then `Step 2 of 2`, `Save 25 cards?`, and Confirm & Save lands
  `Saved 25 cards.` again.

So the flow writes, on top of the 25 cards: one PLAYER (a real Roanoke name,
Hockey) with one stint, two TEAMS `RXT<token>` and `RXO<token>T` (Hockey),
each on one card, `teamNoneConfirmedAt` on another, `teamCheckDoneAt` on
every card, and a second commit of the same 25 cards. The set stays single-use per preview
deployment and the flow remains its sole writer. Every card is `NNO`, so
cards are told apart by POSITION in the section, by the team they carry, or
by the drawer's own order — never by number or marketplace name.

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
assertion in the flow, so `Kept all 25`, `Save 25 cards?`,
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
correctly; the fix is a fresh `npm run test:e2e:seed`. **A local validation therefore gets
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
Pirates AHL`, `Halifax Mooseheads QMJHL`. (`Tulsa Oilers CHL`, `Memphis
RiverKings CHL`, `San Antonio Iguanas CHL` and `Fort Worth Fire CHL` were
spares too; since NEO-330 each is a wizard flow's own fixture — see "The 1995
minor-league hockey wizard fixtures".)
Swapping is a one-line edit to `output.SET` in the flow's STEP 0 plus the two
name literals in this section. Avoid names carrying regex metacharacters or a
`/` (`Electrolarm/Z-104 …`, `Kellogg´s …`).

### Hockey → 1997 — the via-All-Brands brand fixture (NEO-237) ✅ CLAIMED by Jason 2026-09-21

**What was asked for (plan §0.1, answered "yes, Hockey 1997 claimed"):** one
real YEAR — **Hockey → 1997** — owned end to end by exactly one flow,
`tests/set-selector/brand-via-all-brands-narrows-sportlots.spec.ts`, which proves
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
| pre-synced by `tests/setup.spec.ts` | **no** |
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
   Bowman (`tests/setup.spec.ts`'s 2026 Bowman step, the merged flagship flow's STEP 1). What follows
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
`tests/set-selector/known-brand-files-set-and-operator-move-sticks.spec.ts`,
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
| pre-synced by `tests/setup.spec.ts` | **no** — the flow pays its own cold syncs on its own runner |
| re-runs | **fresh-only per deployment**, the same contract as the 1995 and 1997 hockey fixtures: a second run finds the set already under `Unknown` and already stamped, so the flow's `Manufacturers: CMC — change` assertion fails by name. CI reseeds the preview every run, so the first-run path is the CI path; re-seed before re-running locally. The flow deliberately does NOT restore the set — a restore would make a re-run green while proving the filing from the operator's own move rather than from the list |

**The shared-sport question, answered: it adds no row above set level.**
Baseball's Years column is synced from the marketplaces and already holds
1990, and the year level of `drillToColdManufacturer` has no create path
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
that half lives marketplace-free in `tests/set-selector/move-set-to-another-brand.spec.ts`
(`msb-` prefix below); only the two claims above need a real year.

### The TEAM-link alias fixture — Baseball / 1996 / All Brands / Line Up Venezuelan Winter League (NEO-330) — approved by Jason 2026-10-10

One real set, touched by exactly one flow,
`tests/set-selector/checklist-wizard-link-team-saves-alias.spec.ts`, which fetches and COMMITS its
checklist. Approved by Jason 2026-10-10 for a probe and, on a measured team
row, the re-fixture; measured live on PR #314's Convex preview that day with
the reference catalogue loaded and SportLots live.

**What the flow proves** (NEO-284): a LINK decision on a TEAM row in the
entity-review wizard (since NEO-307 taken from the step's one `Search all
teams` combobox; since NEO-326 the combobox starts empty inside a "Link to
existing team" section, with the "Remember …" box directly under it) keeps
the checklist's raw spelling as an alias of the linked team, by default, and
the alias is written at COMMIT — so it needs a real set whose wizard raises
TEAM steps, and it needs to commit. Plus NEO-307's alias-clash refusal.
NEO-307's past-era team claims are not here (Jason, 2026-10-10: the
operator's past-era link belongs where the catalogue holds several
same-name clubs, and this set's clubs are absent from it); see "The PAST-ERA
team fixture" below.

**Why this set.** The reference catalogue holds every MLB-era club, the
Negro League clubs and current MiLB/indie clubs. On the old fixture (2024
Topps MLB at Rickwood Field Negro Leagues Collection) the flow could no longer
create its own `Pittsburgh Crawfords` (CI run 38063558063 failed on its
"No matches." precondition), and the set's clubs and players are catalogue
rows, so its review would not raise the team steps the flow needs. Jason
asked for national-team or defunct-MiLB candidates; this Venezuelan winter
league set is the one he approved for a probe. Its eight clubs are absent
from the catalogue.

| | |
| -- | -- |
| BSC cards | **300** (BSC `teamName` facets: Tigres de Aragua 47 listings, Leones del Caracas 38, Navegantes del Magallanes 35, Aguilas del Zulia 33, Pastora de Occidente 32, Tiburones de la Guaira 31, Caribes de Oriente 29, Cardenales de Lara 26) |
| unknown names | **200 players + 8 teams** at open (`Kept all 300 cards from BSC … 200 new players + 8 new teams need confirmation`, `0 of 208 reviewed · 208 still being looked up`) |
| settled | **211 rows** after ~144 s of LIVE Wikidata lookups (no other runner on the pool; measured before the recording, which now answers all 211): the 8 clubs, ONE staged league (`New League: Venezuelan Professional Baseball League`) and TWO staged career teams (`New Team: EDA Rhinos`, `New Team: Athletics` — Wikidata stints, not checklist clubs) |
| step order seen | the league, EDA Rhinos, Athletics, Navegantes, Cardenales, Tigres, Aguilas, Leones, Pastora, Caribes, Tiburones — the flow does not depend on it |
| cost | ~6–7 min end to end locally with LIVE lookups, ~144 s of it the lookups (before the recording) |

**The row under test is named.** The flow walks every team/league step,
reads its heading, links **Navegantes del Magallanes** to its minted team
`Loc<token> Ali<token>` (alias kept) and skips every other step. Until the
past-era claim moved out (NEO-330), it also linked **Tigres de Aragua** to
the catalogue's single `Pittsburgh Crawfords` row and read the linked card
back on a re-entry of the set; that wrote nothing onto the catalogue row
(remember-box unticked), so no cleanup was needed when it was dropped.

**One-sided, and the flow keeps it that way.** The set row and its `Base`
carry a BSC id only (it is in the All Brands view because no SportLots brand
claims it). The fetch util CANCELS the base picker, so exactly one side is
attached and the fetch takes the NEO-255 solo path ("Kept all 300 cards from
BSC").

**Sole writer, self-cleaning on the TEAM side.** The flow links Navegantes to
its per-attempt team, commits, reads the alias back in Team Management, then
REMOVES it (and the `Pca<token>` alias it gave the team for the clash check)
and saves. The set itself drains within a run like the other committing
fixtures (a committed set's names are known; a re-sync raises no review), and
CI reseeds every run. A LOCAL re-run needs a fresh seed.

**Concurrency and load.** No other flow reads this set. The Baseball → 1996
columns above it are shared with `inserts-1996-score-one-nb-set-two-bsc-sources`
(Score), which drills the `Score` brand; this flow opens the year's All Brands
view, whose first Sets sync is year-wide on BSC. A concurrent first sync
doubles the round-trip, never the rows (measured for Hockey 1994, see the 1995
hockey section). The batch's lookups no longer leave the deployment: the
NEO-289 enrichment recording answers all 211 of them (200 players, the 8
clubs, the 2 staged career teams and the staged league; checked offline
against the committed file, 2026-10-10). They still run through the
deployment-wide pool (`maxParallelism: 5`) that every runner's wizard flows
share, so on CI they can queue FIFO behind other flows' LIVE lookups. The
flow's 180 s lookup ceiling is the live-lane value, kept until the first CI
run with the recording deployed measures the recorded settle time to tighten
it to (R5). Read the convex-logs artifact before touching that number.

**Retired:** `Pittsburgh Crawfords` is no longer created or linked by the
flow (the catalogue has it). Both past-era claims (the automatic link of a
club held once, and the operator's link among several eras) live in
`tests/set-selector/checklist-wizard-past-era-team-link-commits.spec.ts`; the resolution rule itself
(`resolveTeamForSetYear` with `allowPastEra`) is unit-tested in
`lib/teams/team-era.test.ts`.

### The PAST-ERA team fixture — Baseball / 2025 / Topps / Topps Welcome to the Club: 3X MVP (NEO-330) — approved by Jason 2026-10-11

One real set, touched by exactly one flow,
`tests/set-selector/checklist-wizard-past-era-team-link-commits.spec.ts`, which fetches and COMMITS
its `Base`. The flow also claims the whole of **Baseball → 2025**: its drill
runs the year's first Manufacturers and Topps Sets syncs, and no other flow
drills that year. Approved by Jason 2026-10-11 after the probe below; the
earlier candidate, 2024 Topps' "1989 Topps Baseball 35th Anniversary
All-Stars" insert, clashed with the SportLots-twins flow's `Insert` column.

**What the flow proves** (NEO-307, both halves): on a 2025 set, a club the
catalogue holds ONCE in an era that ended long ago links on its own at the
fetch (Brooklyn Dodgers, cards #25–#27), and a club it holds in SEVERAL past
eras, none covering 2025, comes to the operator as one team step offering
every era by its label. The era the operator picks is what the commit writes
onto that club's cards (#34 and #35).

**Why this set.** Every retro Base checked (Archives, Tribute, Gilded, Museum,
Diamond Kings, Cooperstown) stages same-name legends as pick steps, so its
review is never just the team step. This is a 36-card star set whose twelve
players each resolve to one catalogue row (the fetch stages no player). Its clubs, per
BSC's `teamName` facets: Philadelphia Athletics on #34 and #35 (Jimmie Foxx),
Boston Red Sox on #36 (Foxx), Brooklyn Dodgers on #25–#27 (Roy Campanella),
and current MLB clubs on the rest.

| | |
| -- | -- |
| BSC cards | **36** (`Base`; the set also lists 13 parallels of 36 and 208 insert cards, which no flow touches) |
| unknown names | **0 players + 1 team** at open (`Kept all 36 cards from BSC … 0 new players + 1 new teams need confirmation`, `0 of 1 reviewed · 1 still being looked up`) |
| the step | `New Team: Philadelphia Athletics`; its empty `Search all teams` list offers the catalogue's four rows of the name, `same name · NA · 1871–1875`, `same name · MLB · 1876–1876`, `same name · AA · 1882–1890`, `same name · MLB · 1901–1954`, then one close match (`ACL Athletics`) |
| settled | the one lookup (Wikidata Q1264750 and ESPN) took ~8 s live; the NEO-289 recording now answers it (the team entry `philadelphia athletics` under Baseball's Q5369) |
| after the commit | MEASURED read-only: #34 and #35 carry the 1901–1954 row, #36 the Boston Red Sox, #25–#27 the one Brooklyn Dodgers row (1911–1957); no alias on any Athletics row |
| cost | 2m50s end to end locally (PR #314's preview, 2026-10-11) |

**The catalogue facts it depends on.** Four Baseball teams named
`Philadelphia Athletics` (eras above), one `Brooklyn Dodgers`, and a `Jimmie
Foxx` whose stints include the 1901–1954 Athletics (1925–1935) and the Red
Sox (1936–1942). A refresh that adds a row covering 2025, drops an era or
gives the name an alias changes the step or removes it, and the flow fails
on R2(a)–(c) by name: re-probe before re-pointing it.

**One-sided, and the flow keeps it that way.** The set's `Base` is listed on
BSC; the fetch util CANCELS the base picker, so the fetch takes the NEO-255
solo path ("Kept all 36 cards from BSC"). The re-entry for the read-back
cancels it again.

**Sole writer, drains within a run.** The operator's link is made with the
remember-box UNTICKED, so nothing is written onto the shared catalogue rows;
the only writes are the set's structure and its 36 cards. A committed set's
names are known and a re-sync raises no review, so the fixture is spent once
per run; CI reseeds every run. A LOCAL re-run needs a fresh seed.

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
| controls present | `Add as New Player`, `Link to Existing…`, `Skip — not a person`, the career-team mini-form, `Back to Match Cards`, `Add All Remaining as New (88)`, `Skip Remaining (88)` |
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

**Why its players are unknown.** `tests/setup.spec.ts` commits 2024 Topps Chrome's Base,
Future Stars and Gold Wave players (~494 rows). Big League's base is a different
player pool — current players, prospects and veterans outside Chrome's 200 — so
87 of its 88 names are new. That is the fixture, and it is fragile in exactly
one way:

> ⚠️ **NOTHING MAY EVER COMMIT THIS SET'S CHECKLIST.** A commit creates those 87
> players, and a name that is known is not an unknown — the next fetch opens the
> wizard on nothing and all four flows fail. `tests/setup.spec.ts` therefore provisions
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

### Topps Chrome NPB — the same-name PICK STEP fixture (NEO-332) ✅ APPROVED by Jason 2026-10-10

`Baseball → 2024 → Topps → Topps Chrome NPB → Base` belongs to exactly one flow,
`checklist-wizard-same-name-pick-step`. `tests/setup.spec.ts` provisions nothing for it:
the flow syncs its variant types and maps Base on both sides on its first drill,
through `fetchChecklistToWizard`, like the three committing
fixtures above.

**What the flow does to make the fixture.** Before it fetches, it adds a
Baseball player named after card #1 on `/admin/players` — `Shuya Yamada`,
b. 1851 — beside the catalogue's own `Shuya Yamada` (below), so that name
reaches the wizard as a row two players on file answer to, which is what the
pick step ("Which Shuya Yamada is this?") is for. Card #1 is Shuya Yamada RC, Hanshin Tigers (TCDb), and BSC spells it the
same: the pick heading read `Which Shuya Yamada is this?` on the first live
fetch.

**Why NPB, and not an MLB team set.** The name only reaches the pick step while
card-year narrowing (`narrowSameNamePlayersByCardYear`) cannot pick one row: no
same-name player may hold a stint on the card's printed team covering 2024. The
b. 1851 row holds no stints at all. On an MLB team set the catalogue's own row for the
name would carry that stint and the step would never open.

**Two on file: the catalogue's man and ours (NEO-330 catalogue, measured
2026-10-11).** The reference catalogue is a prod snapshot and already holds a
`Shuya Yamada`: Wikidata-linked, Hanshin Tigers from 2026, no birth year. His
span covers a 2024 card within the ±2-year tolerance, so he survives the
narrowing; his only stint starts after 2024, so the card's team does not pick
him outright. The step therefore lists two and its intro reads `We've got 2 on
file under that name.` ⚠️ If a catalogue refresh moves his stint to 2024 or
earlier, or drops him, the step disappears: the flow fails at STEP 1 by name.

**Why one row of our own, not two (CI run 38197074499).** The flow used to fork
b. 1851 and b. 1852. On a catalogue preview the second create is REFUSED, every
time: `createByAdmin` (`adoptOrForkOnCreate`, NEO-254) forks past one undated
rival but refuses once there are several and any is undated — "2 players are
already filed under Shuya Yamada. Pick the right one instead of adding
another." The catalogue's row is undated, so a second dated fork cannot be made
through the product while he is on file.

**Read-only on the set.** The flow leaves through Cancel → Discard: it commits
nothing and creates nothing from the wizard. It does write one GLOBAL `players`
row named `Shuya Yamada` (b. 1851) that nothing deletes, so:

* ⚠️ **No other flow may fetch a checklist carrying that name.** Its wizard
  would open a pick step where it expects a New Player step.
* ⚠️ **No flow may commit this set.** A commit creates or links a Yamada with a
  2024 Hanshin stint, which narrows the name and removes the step for the rest
  of the run.
* **Re-runs are idempotent.** On a deployment that already holds the b. 1851
  row, the create ADOPTS (a birth year exactly one row carries), and the flow
  asserts the row exists rather than that it created it. A review batch a
  red attempt left behind is detected by one read of the decided count and
  cleared through `discardResumedReviewBatch` (with `SET` passed
  through) only when that count is not 0, so the normal path pays no 7s dwell.

**What the fetch stages, on the catalogue-loaded preview (2026-10-11).** Of the
set's 216 player names the catalogue holds 196, so the batch is **21 player
rows**: Shuya Yamada, inserted READY (no lookup until Create new), and **20
unknown NPB names** — Akinobu Okada, Adam Walker, Daisuke Miura, Hironori
Miyoshi, Kazuyoshi Tatsunami, Keishi Tsuda, Keisuke Honda, Kosuke Kawachi, Kota
Nishidate, Leandro Cedeno, Ryusei Satoh, Ryutaro Hatsuki, Satoshi Nakajima,
Taisei Ota, Takashi Uemoto, Takayuki Kajitani, Takero Okajima, Takumi Ohshiro,
Yuki Udagawa, Yuya Shinto. None is in the enrichment recording; Wikidata knows
all twenty. All twelve card teams are in the catalogue, so no team row exists at
open. Two lookups stage career teams the catalogue lacks: Adam Walker (Kanagawa
Future Dreams, Oisix Niigata Albirex Baseball Club, Rakuten Monkeys) and Leandro
Cedeno (Caribes de Anzoátegui, Leones del Caracas), plus any league those teams
need. Shuya Yamada's own lookup finds no career team. Every catalogue refresh can
change these counts: prod builds sets, and a name prod has built is known.
(Before the catalogue, on dev 2026-10-10, the same fetch staged 244 unknown
names.)

**The timing claim, and why it holds.** STEP 1 asserts that the wizard opens on
the pick step while the other names are still being looked up (Jason,
2026-10-11: the claim stays in E2E). What holds the window open is the pool's depth, not
how slow one lookup is: the 20 unknown names need at least four rounds of the
deployment's 5-wide FIFO pool, and every career team they stage is queued behind
all of them, so the header's `· N still being looked up` stays on screen until
the last settles. One lookup's Convex-side time varies widely — 0.3s to 20s in
one batch on the PR preview (2026-10-11, with Wikidata 502 retries), ~4-5s in CI
run 38073638557 — so even an all-fast batch keeps the tail ≥ ~2.5s; contention
from other flows only lengthens it. The flow's first read after the wizard opens
is that assertion, ~1s after the batch starts. Measured on the PR preview,
2026-10-11 (laptop and Convex clocks): batch start +0.0s, first five lookups
+0.5s, STEP 1 COMPLETED +1.1s, last player lookup started +13.3s, first team
settled +14.1s, tail gone +44s (+26.7s without one late 502 retry).

**Then the flow walks.** An untouched pick step yields to the first settled
team or league (teams first, NEO-236), and the career teams above settle ~14-25s
in, inside the window the Create new / Back to the list / link steps need. So
after STEP 1 the flow runs `walkToPlayerRow`, which waits the
batch out, answers each team and league step as a skip, and stops on the first
player row: Shuya Yamada's pick step, because rows are inserted in card order
and he is card #1. Every later count is read relative to those skips (K), and
the link's read-back comes from `Back to previous decision` → `Decision for
Shuya Yamada`, because the Decided list folds past five.

**What a green CI run must show** (fill in from the first green run on the
catalogue preview): in the flow's `maestro.log`, STEP 1's
`"Which Shuya Yamada is this\?", Below "Step 1 of [0-9]+"` COMPLETED within
~1-2s of the fetch util's `Tidy up this set` gate (NEO-335 Phase 2: the
header's counter is "Step x of y" and no longer carries the "· N still being
looked up" tail, so STEP 1's "still looked up" half rests on that timing); in `convex-logs`, the 20 NPB names' `enrichment_fixture`
miss lines spread over ≥ ~12s and the first staged `team` lookup starting after
STEP 1 completed; total flow time against the per-flow cap.

**The kind guard.** Two flows (`link-to-existing`, `career-team`) act on
controls only a PLAYER row renders, and which row settles first is a race
between live Wikidata lookups. Each opens with a `when: visible: id: "Skip .* not
a team"` guard that skips a team row if that is what came up. On the 87-in-88
path the guard costs one poll and does nothing — a deliberate, documented R10
exception, taken because the alternative is a flake with no relationship to the
feature under test.


### Per-attempt custom SPORT rows — `custom-entry-survives-resync`, self-cleaning

`tests/set-selector/custom-entry-survives-resync.spec.ts` creates one custom SPORT row per attempt,
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
`tests/set-selector/checklist-title-length-limits-and-fixer.spec.ts` (NEO-101) do it because they
assert an EXACT count of the cards needing attention, and an exact count is
only knowable on a checklist this attempt created from empty. The NEO-101 flow
additionally names the card its walker must present, so a leftover flagged row
would put the wrong question on screen.

| Prefix | Owning flow |
|---|---|
| `attr-edit-` | `tests/set-selector/set-attributes-edit.spec.ts` |
| `cag-` | `tests/set-selector/card-autograph-always-visible-saves.spec.ts` |
| `cap-` | `tests/set-selector/card-autopopulates-features.spec.ts` |
| `ccrud-` | `tests/set-selector/custom-card-crud.spec.ts` |
| `cd-` | `tests/set-selector/card-detail-panel.spec.ts` |
| `cft-` | `tests/set-selector/card-features-editor-toggle.spec.ts` |
| `cna-` | `tests/set-selector/checklist-attention-badge-and-filter.spec.ts` (also `-${ATTEMPT_ID}`) |
| `cnw-` | `tests/set-selector/checklist-attention-walker-missing-team.spec.ts` (also `-${ATTEMPT_ID}`) |
| `clt-` | `tests/set-selector/custom-card-row-opens-panel-with-autotitle.spec.ts` |
| `cpx-` | `tests/set-selector/set-attributes-card-prefix.spec.ts` — an Insert row `CPXROW` under it carries the Card prefix under test; the flow clears the prefix before it ends. |
| `cvar-` | `tests/set-selector/variation-link-group-and-unlink.spec.ts` |
| `fp-` | `tests/set-selector/features-propagation.spec.ts` |
| `msp-` | `tests/admin/player-sports-multi-sport-membership.spec.ts` (NEO-313) — under the REAL `Baseball` › 2024 › `Topps` (the set's sport must be Baseball: the flow gives a football player Baseball and proves a baseball card's picker finds him); `Insert` › `Base`, one card `316-<attempt>` linking the player `Gm<token>`, DELETED at the end. The set and its rows stand. |
| `msb-` | `tests/set-selector/move-set-to-another-brand.spec.ts` — its OWN sport `msb-sport-<worker>`, brand rows `Topps` / `Panini` under it in 2026 (hand-made, no ids), and ONE set `msb-a-<worker>` under `Topps`. The flow moves that set to `Panini` and back, so it ends where it started; `Panini` stays empty. Per-worker only (no count is asserted). **Never under `E2E Test Sport <worker>`** — it adds a brand row, see the fold note below. |
| `mtf-` | `tests/set-selector/checklist-missing-team-fixer-hand-added-card.spec.ts` (NEO-330, also `-${ATTEMPT_ID}`) — under the REAL `Baseball` › 2024 › `Topps`: the quick-add PlayerPicker and the fixer's TeamPicker search the set's sport, where the reference catalogue's Baseball rows live, and the real 2024 year is what makes the fixer offer the player's whole career ("No 2024 team on file"). `Insert` › `Base`, one card `851-<attempt>` linking the catalogue's **George Brett** with no team, then given the catalogue's **Kansas City Royals** in the attention walker's fixer; the card is DELETED at the end. Both catalogue rows are only READ (the flow writes the card alone). Per-attempt because the header count and the walker queue are exact. The set and its rows stand. |
| `parallel-feature-` | `tests/set-selector/cards-parallel-custom.spec.ts` — under `E2E Test Sport <w>` › 2026 › Topps; its hand-made `Parallel` type is a Parallel type by its title (NEO-334), so its rows are parallels of a Base the set never gets (the checklist shows the build-from-Base stand-in). |
| `pg-cancel-` | `tests/set-selector/parallel-grouping-cancel-discards.spec.ts` (also `-${ATTEMPT_ID}`) |
| `pg-demote-` | `tests/set-selector/parallel-grouping-demoted-parallel-takes-parallels.spec.ts` (also `-${ATTEMPT_ID}`) — three inserts `<ATTEMPT_ID> Stars` / `Stars Gold` / `Stars Blue`; Gold and Blue are saved as parallels of Stars, then Gold is demoted and Blue re-parented under it in one save (NEO-300). Per-attempt because the flow taps inside the Group Parallels body at positions that hold only for exactly these three rows. |
| `pg-move-` | `tests/set-selector/move-parallels-of-inserts-custom.spec.ts` |
| `pg-multi-` | `tests/set-selector/parallel-grouping-multi-select-moves-together.spec.ts` (also `-${ATTEMPT_ID}`) — three inserts `<ATTEMPT_ID> Aces` / `Bolt` / `Comet`, none a prefix of another so nothing is suggested; Bolt and Comet are ticked together and saved as parallels of Aces in one save (NEO-300). Per-attempt because the flow taps inside the Group Parallels body at positions that hold only for exactly these three rows. |
| `pg-reject-` | `tests/set-selector/parallel-grouping-reject-parallel.spec.ts` (also `-${ATTEMPT_ID}`) |
| `pp-` | `tests/set-selector/player-picker-create-custom-card.spec.ts` |
| `rnm-` | `tests/set-selector/rename-selector-option.spec.ts` (also `-${ATTEMPT_ID}`; renamed in-flow to `rnmx-`) |
| `stt-` | `tests/set-selector/set-team-carries-down-to-cards.spec.ts` (also `-${ATTEMPT_ID}`) — under `E2E Test Sport <w>` › 2026 › Topps, NOT Baseball: the New Team dialog's `League` combobox (NEO-307) then lists only leagues this worker minted, so its typed filters match exactly what the flow expects. It mints ONE league, `STL<token>L`, on STA's dialog and picks it back on STB's (see the minted-names table). Per-attempt because the cascade confirm's body is an EXACT card count. Its two cards are deleted at the end; the set, its `Insert` › `Base` rows and its three teams stand. |
| `tlf-` | `tests/set-selector/checklist-title-length-limits-and-fixer.spec.ts` (also `-${ATTEMPT_ID}`) |
| `stn-` | `tests/set-selector/card-title-uses-short-name-for-titles.spec.ts` (also `-${ATTEMPT_ID}`, then `-` and a 60-character hyphenated tail with no spaces, so the set name cannot fit a title core yet still wraps in the Sets column) — under the REAL `Baseball` › 2024 › `Topps`; `Insert` › `Base`, one card `SN1`, and a `Short name for titles` (`SNT<token>`) on that `Base` row. Nothing is deleted: the set is the attempt's alone. |
| `tp-` | `tests/set-selector/team-picker.spec.ts` |
| `tpr-` | `tests/set-selector/team-picker-ranks-by-set-context.spec.ts` (NEO-331) — under the REAL `Baseball` › 2024 › `Topps`: the picker ranks by the set's League feature, which is derived ONLY at the sport level for the four stick-and-ball sports (Baseball → "MLB"), so a synthetic sport would leave nothing to rank by. `Insert` › `Base`, whose checklist row is the picker's context. **Writes no card**: the whole flow runs in the quick-add form's TeamPicker, whose chips are local state, and cancels the form. Mints four teams and one league (see the team-names table); the set and its rows stand. Per-worker only. |
| `tpc-` | `tests/set-selector/team-picker-create-custom-card.spec.ts` |
| `vtk` | `tests/set-selector/variant-type-title-is-its-kind.spec.ts` (NEO-334) — ONE set per attempt, `vtk<token>` (single token: `ATTEMPT_ID` with its hyphens folded, which also carries the runner), under the REAL `Baseball` › 2024 › `Topps`. Hand-made, so neither marketplace side is resolvable at any level beneath it and its Base mapping answers "Nothing to link yet" without a round trip. Inside it the flow creates the variant types `Inserts` (renamed in-flow to `Insert`), `Parallel`, `vtkpro<token>` (renamed in-flow to `Base`) and `vtksec<token>`, the inserts `vtkins<token>` (under Inserts) and `vtkpar<token>` (under Parallel), and the sub-variant `vtksub<token>`. Per-attempt because the flow renames types and makes a Base: a retry in a set that already holds them would refuse the very creates it needs (one Base per set; singular/plural siblings refused). Nothing is deleted; the set stands. The kind words are deliberately NOT minted — they are the input under test, scoped by the per-attempt set. |
| `WOSet3-` | `tests/set-selector/new-chain-autopopulates-features.spec.ts` (under synthetic `E2E Test Sport N`) |
| `xb-` | `tests/set-selector/all-brands-view-lists-every-set.spec.ts` — its OWN sport `xb-sport-<worker>`, brand rows `Topps` / `Panini` under it in 2026 (hand-made, no ids), and one set under each: `xb-a-<worker>` (Topps) / `xb-b-<worker>` (Panini). Per-worker only (no count is asserted). **Never under `E2E Test Sport <worker>`** — it adds a brand row, see the fold note below. |
| `xsp-` | `tests/set-selector/card-player-picker-cross-sport.spec.ts` (NEO-313) — under the REAL `Baseball` › 2024 › `Topps` (the set's sport must be Baseball: the card's picker defaults to it and the flow switches it to Football); `Insert` › `Base`, one card `315-<attempt>` linking the FOOTBALL player `Gp<token>` as a guest, DELETED at the end. The set and its rows stand. |
| `xag-`, `xsrc-` | `tests/set-selector/cross-release-card-appears-in-guest-checklist.spec.ts` |
| `xbg-`, `xbs-` | `tests/set-selector/cross-release-import-reports-missing-numbers.spec.ts` |
| `xcg-`, `xsrc-` | `tests/set-selector/cross-release-hide-toggle-filters-guest-cards.spec.ts` |
| `xdg-`, `xds-` | `tests/set-selector/cross-release-unlink-keeps-card-in-home-set.spec.ts` |
| `xp-` | `tests/set-selector/custom-set-exists-elsewhere-offers-drill.spec.ts` — its OWN sport `xp-sport-<worker>`, brand rows `xp-<worker>-A` / `xp-<worker>-B` under it in 2026, and a set `xp-<worker>-<attempt> Chrome` under B. **It must never use `E2E Test Sport <worker>`** — see the fold note below. |

`xsrc-` is intentionally shared between the two cross-release flows that both
need the same guest-source set; it is still per-worker.

### Adding ROWS to a shared column pushes other flows' controls under the fold

A per-worker custom SET is free. A per-worker custom **manufacturer, year or
sport row added under an ancestor other flows drill through is not** — it makes
that column taller for everybody.

The columns start at y≈380 (the Admin Tools block sits above them) and each row
is ~58px in the 1024×625 headless viewport, so a column's `Sync <X>` / `+ Custom`
buttons fall off the bottom at roughly the **fourth** row. `drillToCustom` (support/set-builder.ts)
waits for `Add custom <X>` **without scrolling** at several levels — a deliberate
guard against a CDP crash during re-render — so once those buttons are under the
fold the drill cannot recover and every consumer of that ancestor fails.

This is not hypothetical. `tests/set-selector/custom-set-exists-elsewhere-offers-drill.spec.ts`
originally created two brand rows under the SHARED `E2E Test Sport <worker>` ›
`2026`, which `drillToCustomSet` (support/set-builder.ts) pins 7 flows to. In PR #226 run 1
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
`drillToCustom`'s unscrolled Level-3 wait.

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
with no place in it ("Athletics", "Liverpool") is meant to ship blank. **`tests/admin/team-management-edit-a-team.spec.ts` is the one exception**:
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

The consequence for flows: **the bulk tap no longer reaches the end of the
names on its own.** Every team the batch does not already hold — a checklist team name,
or a career team staged off a player's Wikidata history — gets its own
**New Team step** (`New Team: <name>`), because that step asks which LEAGUE and
the bulk path could only ever guess it from the enrichment's suggestion.

Two flows press that button — `tests/setup.spec.ts` (in its **Base** block only;
NEO-260 deleted the dead Insert and Parallel copies) and
`tests/set-selector/inserts-1996-score-one-nb-set-two-bsc-sources.spec.ts` — and each
now answers those steps with the same loop.
`tests/set-selector/signed-by-autofills-from-players.spec.ts` used to be the third; it
pressed the button inside a self-heal fallback that NEO-260 removed (see its
entry under the sole-writer notes):

```yaml
- repeat:
    times: 250
    while:
      notVisible:
        text: "Next \\(Enter\\)|.*Confirm & Save.*"
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
TERMINAL state (the names-done footer not yet visible) rather than on a step
being visible, because players and their staged teams drain at the same time
and a loop keyed on `New Team:` exits the first time it catches the batch
between lookups. `times` is a runaway guard; the `extendedWaitUntil` on the
names-done footer after the loop is still the real gate.

> **NEO-335 Phase 2 — the names-done footer is TWO states.** With every name
> decided the wizard walks on to a teams step ("Cards with no team") and/or a
> titles step ("Card titles"), each with a footer `Next (Enter)` and no
> Confirm & Save, before its Save step ("Ready to save", `Save N cards?`,
> Confirm & Save). So the terminal state is
> `Next \(Enter\)|.*Confirm & Save.*`, and
> `advanceToSave` (`support/wizard.ts`) walks the rest (Next
> on each, defaults kept) to the Save step.

> **It is `times`, not `maxRuns`.** This snippet published `maxRuns: 250`
> until NEO-260. `maxRuns` is not in Maestro's `YamlRepeatCommand` schema — it
> was invented — and an unknown property is a **hard parse error that kills the
> entire flow before a single command runs**, with a message pointing at a line
> nobody just edited. That is exactly how it took the seed job down once.
> Anyone who copy-pasted this block reproduced the outage the registry
> elsewhere describes. See the comment at `tests/setup.spec.ts`'s own loop.

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

**NEO-307 — the one deterministic route in: a league the operator TYPES.**
Everything above is about a step an ENRICHMENT raises. A step the operator
raises by picking `Create “<typed>”` in a team step's `League` combobox has
neither problem: a per-attempt name (`Lg<token>`) is missing from every sport
by construction, and nothing earlier in the run can have created it.
`tests/set-selector/checklist-wizard-career-team-entry.spec.ts` does exactly that on its minted
`ProbeTeam<token>` step, answers the `New League: Lg<token>` step the walk
presents, reads `Lg<token> (new)` back on the team, and discards the batch — so
the step is asserted live without a new real set and without writing a
`leagues` row.

**NEO-331 — a league step needs a LEVEL, and none is pre-pressed.** `Add as
New League` (and the picker form's `Add league`, and League Management's
`Create league …`) is held until one of the six level pills is pressed. Every
drain answers a league step through `answerStepAsNew` (support/wizard.ts),
which reads the step's kind off the footer button and presses `Other` — the
level the step pre-pressed before NEO-331, so a drained league carries what it
always did. A flow whose assertions depend on a level presses it itself
(`tests/set-selector/team-picker-ranks-by-set-context.spec.ts`'s `Minor`).

**NEO-331 — a league step needs a LEVEL, and none is pre-pressed.** `Add as
New League` (and the picker form's `Add league`, and League Management's
`Create league …`) is held (aria-disabled) until one of the six level radios is
pressed. Every drain answers a league step through `answerStepAsNew` in
`support/wizard.ts`, which reads the step's kind off its heading, presses
`Other` first and waits for the step to leave the screen — the level the step pre-pressed before NEO-331, so a
drained league carries what it always did (the seed's Base wizard drain adds
the "Major League Baseball" league this way, abbreviation MLB). A spec whose
assertions depend on a level presses it itself (`team-picker-ranks-by-set-context`'s
`Minor`).

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
  text) and a `League` combobox (NEO-307: one input, accessible name exactly
  `League`, over a listbox whose options read the sport's league names,
  `<name> (new)` for a league the batch staged, `Create <name>` for an
  enrichment suggestion NB lacks, `Create “<typed>”` ONLY when the typed text
  matches nothing (no league name, alias or abbreviation, staged league or
  suggestion contains it) — in the dialog it opens the league form
  pre-filled, and `Add league` writes the row; in the wizard it stages a
  `New League:` step — and `No league`, always, unfiltered). NEO-326 removed
  the form's `Shows as:` preview and its Location help line, so the composed
  name is asserted through the Create button's accessible name (below) and,
  after the write, the chip or row that reads it. Drive the League as: tap
  `id: "League"`, type a STRICT substring of the option, tap the option by its
  exact text, then read the input back as `{id: "League", text: <label>}` —
  never type the whole label, or the input's own text answers to the tap. Its
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
| `CNAA`, `CNAB` | `tests/set-selector/checklist-attention-badge-and-filter.spec.ts` | two teams; CNAB is the born-linked card's alone, which is what makes its row assertion single-row |
| `RXT` | `tests/set-selector/checklist-one-marketplace-skips-match-dialog.spec.ts` | a HOCKEY team, staged as a career team on the one Roanoke player that flow creates in its review (1994–1996) and decided "Add as New Team"; the NEO-335 pre-fill evidence, read back as `Remove team RXT<token>` in a card drawer |
| `RXO` | `tests/set-selector/checklist-one-marketplace-skips-match-dialog.spec.ts` | a HOCKEY team, `RXO<token>T`, created from the wizard's teams step through a line's "Other team…" picker and the New Team dialog it opens (NEO-335 Phase 2, C1); read back as `Remove team RXO<token>T` in a card drawer. Ends in a LETTER so no other attempt's longer token can contain it as a prefix (Convex search treats the last term as a prefix, which would turn the picker's `No matches.` into a match). Diverges from `RXT` at its third character |
| `CNAP` | `tests/set-selector/checklist-attention-badge-and-filter.spec.ts` | a PLAYER — the born-linked card #703's, created from the quick-add form's PlayerPicker ("Create player CNAP<token>") and read back from that card's drawer. The quick-add create path's one E2E since NEO-335 retired `set-fill-teams-from-teammate-card` (and its `ftl-`/`FTP`/`FTT` names). Diverges from CNAA/CNAB at its fourth character, and lives in `players.search`, not `teams.search` |
| `CNWT` | `tests/set-selector/checklist-attention-walker-missing-team.spec.ts` | |
| `NBTeam` | `tests/set-selector/team-picker-create-custom-card.spec.ts` | created under `E2E Test Sport <w>`, not Baseball |
| `NBPlayer` | `tests/set-selector/player-picker-create-custom-card.spec.ts` | a PLAYER, not a team — `players.search` tokenises identically, and the row persists the same way |
| `Gw` | `tests/set-selector/checklist-wizard-link-commits.spec.ts` | a FOOTBALL player (NEO-313), made on `/admin/players` through `admin/`addPlayerByHand`, which the review wizard links a Topps Brooklyn Collection name to after switching that row to Football. `Gp`/`Gm` below are its siblings; the three diverge at their SECOND character, so none is a prefix of another |
| `Gp` | `tests/set-selector/card-player-picker-cross-sport.spec.ts` | a FOOTBALL player (NEO-313), linked as a guest onto a baseball card from the card picker's sport switch |
| `Gm` | `tests/admin/player-sports-multi-sport-membership.spec.ts` | a FOOTBALL player (NEO-313) who is given Baseball as an added sport, then picked on a baseball card |
| `PM` | `tests/admin/player-management-add-and-career-history.spec.ts` | the PLAYER this flow adds by hand; `PMT` below is the team it gives him. The two diverge at their THIRD character, so neither name is a prefix of the other and neither picker can be answered by the other's row |
| `PMT` | `tests/admin/player-management-add-and-career-history.spec.ts` | |
| `SLP` | `tests/spine-label/player-team-colors-default-to-longest-tenure.spec.ts` | the PLAYER; `SLA`/`SLB` are his two teams. This is the one flow that types a strict PREFIX of a minted name — see the prefix note below |
| `SLA`, `SLB` | `tests/spine-label/player-team-colors-default-to-longest-tenure.spec.ts` | coloured `#132448` / `#002d72` |
| `STA`, `STB`, `STC` | `tests/set-selector/set-team-carries-down-to-cards.spec.ts` | three teams under `E2E Test Sport <w>`, diverging at their THIRD character so none is a prefix of another. Each carries the Location `Loc<token>` (typed into the DIALOG, never into a picker, so the composed `Loc<token> STA<token>` is never queried) — the same shape `tests/admin/admin-franchises-link-teams.spec.ts` gives its `Fr<token>A`/`Fr<token>B` pair, so `TMT` is no longer the only located team. STA is the set's first team, STB is card #2's hand-set override, STC is the set's replacement |
| `TLF` | `tests/set-selector/checklist-title-length-limits-and-fixer.spec.ts` | kept SHORT on purpose: the name lands in a generated listing title measured against an 80-character cap. `TLF<token>` is 8-12 chars, 3 fewer than the `TLF-${ATTEMPT_ID}` it replaced and 4-8 fewer than the "New York Yankees" before that — the rename spends less of the budget, never more. Read the FIXTURE SIZING block in the flow before changing any name in it |
| `TME` | `tests/admin/team-management-edit-a-team.spec.ts` | the throwaway PLAYER that flow creates on the way in, because a career editor is the only place outside the set-builder cascade where a team can be born. `TMT` below is the team it makes there; the two diverge at their third character |
| `TMT` | `tests/admin/team-management-edit-a-team.spec.ts` | the ONLY team in the suite with a `location` (`Loc${WORKER_INDEX}`), so once it saves its composed name is `Loc<w> TMT<token>` — see the composed-name note above for why the extra term is inert |
| `Alp` | `tests/set-selector/checklist-wizard-link-team-saves-alias.spec.ts` | the throwaway PLAYER that flow creates to reach a career editor; `Ali` below is the team it makes there. The two diverge at their third character |
| `Ali` | `tests/set-selector/checklist-wizard-link-team-saves-alias.spec.ts` | the team a checklist club is LINKED to; carries the Location `Loc<token>` (typed into the DIALOG, never into a picker), so the composed `Loc<token> Ali<token>` is what the link option, the decision line and Team Management print. The link SEARCH types the single token `Ali<token>`. Its alias (the club's marketplace spelling) is removed again before the flow ends |
| `Pca` | `tests/set-selector/checklist-wizard-link-team-saves-alias.spec.ts` | an ALIAS, not a team: typed into `Ali<token>`'s New Team dialog so the wizard's alias-clash refusal (NEO-307) has a holder. Never searched; removed with the club's alias before the flow ends |
| `MintedTeam` | `tests/set-selector/checklist-wizard-career-team-commits.spec.ts` | |
| `TPT` | `tests/set-selector/team-picker.spec.ts` | |
| `TPR` | `tests/set-selector/team-picker-ranks-by-set-context.spec.ts` | four teams `TPR<token>QZ` / `QY` / `QX` / `QW` (NEO-331), alphabetical order the REVERSE of their tier order: Z in Major League Baseball from 1958, Y in the minor league `TPRLg` below from 2000, X in Major League Baseball 1900–1957, W in no league from 1958. Z and X PICK the existing "Major League Baseball" in the New Team dialog's League combobox (an unanswered League leaves a team league-less since NEO-331); that row is the reference catalogue's on a catalogue preview (NEO-330: level Major, abbreviation MLB) and otherwise `tests/setup.spec.ts`'s (its Base wizard drain adds the New League step, level Other, abbreviation MLB), and this flow never creates it. The flow types the shared prefix `TPR<token>Q`, which ENDS IN A LETTER so no other attempt's longer token can prefix-match it and interleave its rows (a digit sorts before "Z"). `TPR` and `TPT` diverge at their third character |
| `TPRLg` | `tests/set-selector/team-picker-ranks-by-set-context.spec.ts` | a LEAGUE, named `TPRLg<token>M`, level **Minor** (load-bearing: it is what puts `TPR<token>QY` in tier 2), created from Y's New Team dialog (`Create “TPRLg<token>M”` → `Minor` → `Add league`) in **Baseball**. Trailing letter for the `STL<token>L` reason. No flow deletes it, so one row per attempt stands in Baseball |
| `ProbeTeam` / `TempTeam` | `tests/set-selector/checklist-wizard-career-team-entry.spec.ts` | never persisted — the flow discards its batch |
| `STL` | `tests/set-selector/set-team-carries-down-to-cards.spec.ts` | a LEAGUE, not a team, named `STL<token>L`: created from STA's New Team dialog (`Create “STL<token>L”` → `Add league`) under `E2E Test Sport <w>`, then picked as an existing league on STB's by typing `<token>L`. The trailing `L` is load-bearing: the create option appears only when the typed text is a substring of NO league, the token's random tail varies in length, so a bare `STL<token>` can sit inside an older attempt's name — a letter after the digits makes it contained in none. No flow deletes it, so one row per attempt stands in that worker's sport; nothing else types into that sport's League combobox except `No lea` |
| `Lg` | `tests/set-selector/checklist-wizard-career-team-entry.spec.ts` | a LEAGUE staged on ProbeTeam's wizard step and picked as `Lg<token> (new)` on TempTeam's — never persisted, the batch is discarded |

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
(`tests/set-selector/player-picker-create-custom-card.spec.ts`), `PM`
(`tests/admin/player-management-add-and-career-history.spec.ts`), `SLP`
(`tests/spine-label/player-team-colors-default-to-longest-tenure.spec.ts`) and the
throwaway `TME` that `tests/admin/team-management-edit-a-team.spec.ts` needs in order to reach
a career editor at all. There is no exception left, and no new one is coming: a
new player name is `<Prefix>${output.ATTEMPT_TOKEN}` like every team name.

**Typing a PREFIX of a minted name is still allowed — and it is still one
token.** One step in the suite does it deliberately: the spine designer's player
search in `tests/spine-label/player-team-colors-default-to-longest-tenure.spec.ts` types the bare
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

- `tests/set-selector/base-mapping-cancel-recovers.spec.ts`
- `tests/set-selector/checklist-bsc-team-enrichment.spec.ts`
- `tests/set-selector/checklist-renders-rich-fields.spec.ts`
- `tests/set-selector/drill-restores-from-url.spec.ts` (NEO-224 — picks rows and goes Back; writes nothing)
- `tests/set-selector/keyboard-only-drill.spec.ts` (NEO-224 — picks rows by keyboard; writes nothing)
- `tests/set-selector/multi-source-panel-opens-dialog.spec.ts` (NEO-325: also reads the Attach dialog's SportLots pane; ticks nothing)
- `tests/set-selector/reconcile-sportlots-twins-keep-their-own-ids.spec.ts` (NEO-325 — opens the `Parallel` reconcile, lets its Base check probe SportLots' pending sets, and never saves; see "SportLots twin names" below)
- `tests/set-selector/sets-base.spec.ts`
- `tests/set-selector/sets-resync-already-loaded.spec.ts`
- `tests/set-selector/topps-chrome-marketplace-read.spec.ts`

**Three flows on this set are NOT read-only, and the list used to say the first two were**
(corrected NEO-260). Each is **sole writer of one datum on the anchor** —
approved by Jason, 2026-09-09 — and neither touches the checklist itself:

| Flow | What it writes | Tolerance |
|---|---|---|
| `tests/set-selector/signed-by-autofills-from-players.spec.ts` | `autographed` / `signedBy` on card **#300** | sole writer of those two fields; no other flow reads or writes them |
| `tests/set-selector/topps-chrome-add-feature.spec.ts` | toggles one feature on the anchor, twice per run | sole writer of that feature; returns it to its starting state |
| `tests/set-selector/base-parallels-build-from-section.spec.ts` (NEO-321) | the CARDS of the first buildable base parallel under `Parallel` (measured: `Sepia Refractors`), rebuilt from Base by the section's run and stopped after the one in flight | sole writer of those rows' cards; no queue flow reads any base parallel's cards; never writes Base, a player, a team or a row. Approved: Jason, 2026-10-04 — see the section below |

**`tests/set-selector/signed-by-autofills-from-players.spec.ts` no longer self-heals an empty Base
checklist (NEO-260).** It used to carry a `when:`-guarded fallback that fetched
and COMMITTED the entire shared Base checklist when it found the set empty —
a write to a registered shared set by a flow entitled to two card fields and
nothing else, and one that converted a failed seed into a green run proving
nothing. `tests/setup.spec.ts` is the flow's documented precondition. The fallback
is now a single positive assertion that the checklist has cards, so an unseeded
run fails loudly instead of rebuilding a fixture the rest of the queue is
reading. **Do not re-add a self-heal branch to any consumer of this set: the fix
for an empty shared set is to fix the seed.**

### 2024 Topps Chrome › Parallel — the base-parallel build (NEO-321) — approved: Jason, 2026-10-04

`tests/set-selector/base-parallels-build-from-section.spec.ts` proves the `Parallels of Base`
section live, so it presses `Build N parallels from Base` on the shared
anchor's `Parallel` variant type, confirms `Replace and build` (K ≥ 1 on every
run: the seed builds Gold Wave) and presses `Stop after this one` while the
first build is in flight. It cannot use a hand-made set: a parallel with no
marketplace ids is skipped, never built (NEO-239), so the build is only
reachable on real data. No new real set: the rows are the seed's.

| What it writes | Who else reads it | Why that is safe |
|---|---|---|
| the cards of the FIRST buildable parallel in `Parallel`'s own child order (`getParallelsForBuild` sorts by `parent.children`) — measured: `Sepia Refractors`. The flow asserts `stopped after 1`, so a Stop that lands after that build finished (writing the next one too) fails the run by name | nobody in the queue: no flow opens a Topps Chrome base parallel's checklist except `tests/setup.spec.ts` (Gold Wave, before the queue starts) | the build reads Base (the source) and never writes it; copies take Base's existing players and teams, so `players` / `teams` gain no row |
| if Stop never lands: every buildable parallel in order, Gold Wave included, until the flow's browser closes (a client-side run, "stopped when you left") | the same nobody | the flow fails by name at `Base parallels — stopped after …` |

**The row is `Sepia Refractors`** — measured in CI run 37179999943 (PR
#305), the first green run: the flow typed `Sepia Refractors` into the
Parallels search from the ledger line it read, and Convex logged exactly one
`parallel_checklist_built` for the run (copied 300, left off 35, BSC +
SportLots). The order is the `Parallel` reconcile's save order, so it is
fixed per seed and moves only if the reconcile saves in a different order;
the flow still reads the name off the ledger at run time and never assumes
it, so a reorder changes the write set without failing the flow. To
re-check it, read the `Inputting text:` line after `Input text
${output.BUILT}` in the flow's `maestro.log`. If it is ever `Gold Wave
Refractors`, nothing breaks (see the table), but the seed's pagination guard
then reads a set this flow rebuilt mid-queue — harmless, since the seed has
already passed, but worth knowing when reading a Gold Wave screenshot.

Concurrent Base writers: `signed-by-autofills-from-players` edits card #300's
`autographed` / `signedBy`. A copy taken while that edit lands is either
copied with it or skipped ("skipped — Base changed them mid-build"); the flow
asserts neither the card nor the count, only that N > 0 cards were built and
that a copy's title names its parallel.

### SportLots twin names (NEO-325) — read-only on the shared anchor, plus one sole writer

SportLots lists distinct sets under one name, and since NEO-325 every place
that names a marketplace set adds its id when the name is repeated on that
side: `Make its own set: <name> (#<id>)`, `Remove <name> (#<id>) from <set>`,
`SportLots base candidate: <name> (#<id>)`, and in Attach sets `Toggle <name>
(#<id>)`. The form is the same on both sides (`#` + the marketplace id). A
name SportLots does not repeat is unchanged. An Attach sets BSC set row that
is already attached shows a visible `attached` marker (`aria-hidden`) and a
screen-reader sentence `<label> is already attached`; that sentence is TEXT
in an sr-only span, not an accessible name, so no `id:` selector can match it
(it was a role-less span's `aria-label` before the NEO-325 a11y pass). The
SportLots pane never shows the marker: it drops attached ids instead. When
two Ready sets in the Reconcile dialog share a TITLE (two promoted twins,
both titled with the bare name), every control on each row names the row by
the ids it maps — `Remove <name> (#A) from <name> (#A)`, `NeonBinder set name
for <name> (#A)` — then `, N of M` if the ids are identical too. Ids from one
marketplace stay bare (`(#A)`, `(#A, #B)`); a row holding ids from BOTH names
each side, BSC first: `<title> (BSC #x · SportLots #y)`. A unique title is
unchanged. Neither twin flow builds a mixed-side shared title: the read-only
flow's two rows are SportLots-only, and City Connect's two rows pair a BSC and
a SportLots set each but carry different titles (Series One / Series Two).

Jason, 2026-10-08, two rules both flows now assert: **a marketplace twin is
never auto-linked or auto-created** — it waits unattached in Reconcile's
Pending for the operator (column sync creates no row for one); and
**Reconcile blocks Save while two Ready sets share a title**, saying "Two
sets are both named “<title>”. Rename one so you can tell them apart." (curly
quotes since NEO-325's copy pass; the flows match each quote with `.`). Three
or more read "<N> sets are all named “<title>”. Rename them …", and a single
Ready set beside a saved row reads "There's already a set named “<title>”
under <Set › Type>. Rename this one …" (or "here" without a parent path);
every form ends "so you can tell them apart.", which is the tail the flows'
negatives match. Each clashing title field also carries its own line, "Same
name as another set. Tip: add the release, like “Series 1” or “Update”."
(DRAFT copy) — no twin-flow selector matches it.

#### Read-only: `tests/set-selector/reconcile-sportlots-twins-keep-their-own-ids.spec.ts`

Proves the names and filtering live with no new real set: 2024 Topps Chrome's
`Parallel` reconcile already receives SportLots' whole 2024 Topps list (the
adapter's insert level is the brand-year list, brand-stripped), and that list
holds a real twin. Promoting both twins gives two Ready sets with one title,
so it also proves the same-title block (message + blocked Save) and that
renaming one clears it. It never presses Save, and leaves through Cancel →
`Discard N set changes`. Since the Parallel reconcile's Base check (NEO-325,
2026-10-09) it also proves that check on the same list's second twin,
"Chrome Black Refractor": one id matches the Base and stays listed, the other
is set aside with its reason (table below).

| | |
| -- | -- |
| twin | "Chrome Update Sapphire" — SportLots ids **323331** and **326059** (USCS18…USCS346 vs USCS24…USCS345, interleaved, one card — USCS220 — in both: SportLots split one checklist across two ids) |
| neighbour | "Chrome Update Sapphire Black Sapphire Refractor" (326060), the row left when the filter narrows past the twins |
| measured | 2026-10-08, SportLots' public buyer search (each row's set id and set name): 824 sets with stock under "2024 Topps Baseball" hold three same-name pairs — this one, "City Connect Swatch Collection" (299607 / 307437) and its "… Black" (299608 / 307438). Only this one starts with "Chrome", so only it shows under the dialog's default SportLots prefix filter. The DEALER list the dialog reads holds one more "Chrome" twin the public search could not see (no stock on one side): "Chrome Black Refractor" (**305604** / **309103**), listed as `Chrome Black Refractor (#305604)` / `(#309103)` (live dialog, 2026-10-08). Since NEO-325 it is never auto-paired, so the seed's Topps Chrome `Parallel` reconcile saves **41** sets, not 42 (BSC `Black Refractors` stays in Pending; `base-parallels-build-from-section` pins 41). Since the Base check (below) the flow DOES match it, as claim 5's fixture |
| writes | none: the dialog is client state (promotions and the rename included), Save is never pressed, and the flow closes it with Cancel → Discard |
| base check (claim 5) | The dialog checks every pending set of this `Parallel` (a Parallel type by its title, NEO-334) against the saved Base — 335 cards — by first card and per-marketplace count (`lib/cards/base-match.ts`), and sets a mismatch aside behind the toggle `N that don't match the Base, SportLots` (the same name open or closed; `aria-expanded` carries the state, so the flow proves open and closed by the revealed row) with its reason, `Doesn't match the Base — …`. The flow types the twin's name and proves ONE NAME, TWO VERDICTS: **309103** stays listed with its row status `, matches the Base`, **305604** is set aside and, revealed, carries its reason. The ids are the planner's reading (309103 = the Topps Chrome Black Refractor parallel, 305604 = the Topps Chrome Black set) and are **NOT YET MEASURED**: pin them, and the probe waits' ceilings, from the first run on a preview carrying the check. The Chrome Update Sapphire twins are USCS-numbered (another product), so they are set aside too; the flow reveals them and proves claims 1–4 on the revealed rows |
| base check reads | one query (`getBaseSignatureForVariantType`) and read-only probe actions (`probeSlFirstPage`, `probeSlCount`, `probeBscSets`) over the column's whole scope, two calls in flight per side, from the moment the dialog opens until it closes; nothing is stored. The seed's own Topps Chrome `Parallel` reconcile runs the same check for the second or two before it presses Save — Save writes Ready only, so it still saves the **41**; the check only changes what Pending SHOWS and what `Keep all` reaches |
| paused | no SportLots list, no twin; the flow does not press `Sync Parallels` (one marketplace takes the single-platform STORE path) |

#### Sole writer — Baseball → 2024 → Topps → Topps (the flagship) › `Insert`: `tests/set-selector/reconcile-sportlots-twins-save-each-to-its-own-set.spec.ts` — ✅ approved by Jason 2026-10-08

The after-save proof (Attach sets on each saved row no longer offers the
twin it holds, and still offers the other) needs a SAVE, which is a write to
a real set; the owner approved this set for it on 2026-10-08 (rule 1). The
flow is this set's **sole writer** and is **not self-cleaning**: like every
real-set sole writer it relies on the run-start reset (`e2e-baseline.sh
reset` before `tests/setup.spec.ts`), and it REQUIRES a fresh `Insert` column (the
reconcile must open on its own), so a dirty deployment fails it at that
gate, by name.

| | |
| -- | -- |
| set | Baseball → 2024 → Topps → **Topps** (BSC's flagship set: Series 1 + Series 2 in one) › `Insert` |
| twin | SportLots "City Connect Swatch Collection": **299607** = the Series One relics (every stocked card `CC-…`, 10 with stock) and **307437** = the Series Two relics (every stocked card `CC2-…`, 15 with stock) |
| BSC counterparts | `City Connect Swatch Collection Relics (Series One)` (32 cards, `CC-AB` … `CC-XB`) and `… (Series Two)` (40 cards, `CC2-ARE` … `CC2-ZN`), both BSC variant `Insert` under setName `Topps` |
| what the flow does | asserts both twins wait in Pending and neither series row is auto-matched; pairs Series One ↔ 299607 and Series Two ↔ 307437 (click one Pending item, then the other), asserts each Ready chip names its own twin and that Save is not blocked, presses `Save N sets`, then opens Attach sets on each saved row: its own twin's id is gone (`No matches for “<id>”.`), the other twin's `id:` is listed and its checkbox reads the bare name. Then the RE-SYNC: `Sync Inserts`, asserts exactly the two series rows come back as Ready sets each holding its own twin and no twin is back in Pending, saves again, and reads the column (each series row once, no row named for the twin) and both rows' Attach sets again |
| cost | no new sync tier: Sport/Year/Manufacturer/Sets are the seed's (the flagship `Topps` row is filed by the seed's 2024 Topps Sets sync); the flow pays one cold Variant Types sync for the flagship and two insert-level BSC + SportLots list fetches (the reconcile, then the re-sync), plus one SportLots list per Attach sets open (four). No checklist is fetched |
| writes | the flagship's Variant Types; every Ready set of the `Insert` reconcile (the auto-matched pairs plus the two built here — the Save writes all of Ready), twice: the re-sync's Save re-stores the same rows by id and must create none. No cards, players or teams. Nothing is detached or deleted. Not self-cleaning: the run-start reset is the cleanup |
| readers | none: no other flow drills below the flagship `Topps` set (only this flow passes `SET: "Topps"` to the drill), so nothing in the queue sees the rows mid-run |
| paused | the flow stops after the drill and writes nothing below the Variant Types |
| measured | CI 37874717642 + a local run against the PR preview (2026-10-08, green end to end, 8m25s): the reconcile opens on its own at ~36 s (cold) and holds **149** auto-matched Ready sets (`Save 149 sets`) with no shared title; the flagship `Topps` row is present after the seed. The dealer list's twins in this family are `… Gold` (**307439** / **299609**), NOT `… Black`: it lists ONE `City Connect Swatch Collection Black` and a `… Black /199`, so the re-sync's no-twin-in-Pending positive matches any `<name> <variant> (#id)` |

Why this set (the candidates weighed, 2026-10-08, all from the public
listings):

| candidate | NB set it would be | why the twins belong there | already loaded by | verdict |
| -- | -- | -- | -- | -- |
| **City Connect Swatch Collection** 299607 / 307437 | 2024 Topps › **Topps** › Insert, two rows (Series One, Series Two) | Series One and Series Two relics of one product; card prefixes `CC-` / `CC2-` match BSC's two series variants one-to-one | seed (Baseball / 2024 / Topps Sets) | **recommended** — each twin goes to its OWN row with its own BSC counterpart |
| City Connect Swatch Collection Black 299608 / 307438 | same set › Insert, the Black relics of each series | same split (`CC-` 2 stocked / `CC2-` 4 stocked) vs BSC `… Relics Black (Series One/Two)` | seed | possible, but the Black rows are parallels of the relics, so the faithful shape needs grouping too |
| Chrome Update Sapphire 323331 / 326059 | 2024 Topps › Topps **Chrome Update Sapphire Edition** › Base (BSC: 350 base cards) | one checklist SportLots split across two ids (interleaved numbers, a shared card): both twins belong to the SAME row | seed (Sets only) | rejected: a Topps Chrome product (owner: not Topps Chrome), and both twins land on one row, so Attach shows neither — no "the other is still offered" proof |
| Bowman vs Bowman Chrome (2022–2026) | 2026 Bowman (seed) / older years (cold) | — | — | **no twin exists**: SportLots names each product's sets with its product word (`Bowman Prospects` `BP-` vs `Bowman Chrome Prospects` `BCP-`), and it files the paper product's `BCP-` chrome prospects and Bowman Chrome's own in ONE set (`2025 Bowman Chrome Prospects` 337845 holds `BCP-1`…`BCP-150`, Bowman's own chrome prospects, AND `BCP-151` on, Bowman Chrome's). That is the 1996 Score shape (one SportLots set backing two NB sets), not a twin. Searched "<year> Bowman Baseball" for 2022, 2023, 2024, 2025 and 2026: zero same-name pairs |

No twin was found in the other provisioned scopes' public listings (2026
Bowman, 1996 Score, 1997 SPx, 2024 Topps hockey) either, nor in 2023 Topps
Baseball (689 sets with stock, for comparison), and none of the 2024
Topps sets the suite uses as a Base (Topps Chrome, Big League, Heritage,
Chicago Cubs, Baltimore Orioles, Brooklyn Collection, 206) is a twin.
SportLots disambiguates most repeats itself with a code (`Mega Box (Mojo
Refractor) (CMP183)` vs `(CMP651)`), so a true twin is rare and SportLots may
merge one. If it does, the flow fails by name at its first `Make its own
set: … (#…)` assert; find a replacement by paging the public search for a
scope the seed already provisions and grouping rows by `SetInfo` with more
than one `SetNbr`, then change the `evalScript` lines at the top of the flow
and this section.

### The Parallel reconcile's Base check (NEO-325) — which registered sets it reaches

The Reconcile dialog checks every PENDING marketplace set against the saved
Base only for a Parallel type (titled `Parallel`/`Parallels` — NEO-334) AND whose Base has
saved cards (`getBaseSignatureForVariantType` answers anything else with a
skip, and the dialog then shows no check at all). It never touches Ready, so
it never changes what a reconcile's Save writes; it changes what Pending
shows (mismatches behind the toggle `N that don't match the Base, <side>`)
and what `Keep all` reaches (only rows already checked and not set aside; the
button's name is `Keep all, <side> sets` when it reaches the whole column and
`Keep all N, <side> set(s)` when a filter or the check narrows it).

| Reconcile in the suite | Role | Base cards? | Check runs? | Effect on the flow |
| -- | -- | -- | -- | -- |
| `tests/setup.spec.ts` — 2024 Topps Chrome › `Parallel` | parallel | 335 (seeded earlier in setup) | yes | none: presses `Save N sets` at once; Ready (the 41) is untouched |
| `reconcile-sportlots-twins-keep-their-own-ids` — same column | parallel | 335 | yes | the flow's claim 5; its twin claims run on the revealed rows |
| `bowman-sportlots-links-move-between-set-parallel-insert` STEP 10 and its re-sync — 2026 Bowman › Bowman › `Parallel` | parallel | none (no flow fetches Bowman's Base checklist) | no (skip: no cards) | none; if a Base checklist is ever saved there, still none — the flow reads Ready chips and presses Save |
| `bowman-insert-grouping-builds-parallels` — 2026 Bowman › `Insert` | insert | — | no | none (its `Keep all N, BSC set(s)` / `Keep all, BSC sets` behave as without the check) |
| `inserts-1996-score-…`, `reconcile-sportlots-twins-save-each-to-its-own-set` — `Insert` columns | insert | — | no | none |

## Adding a set

**Custom set** — pick an unused prefix, add a row to the table above in the same
commit, and drill with `drillToCustom` (support/set-builder.ts):

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
`tests/setup.spec.ts`'s provisioning and its CANONICAL PRE-SYNCED DATA block, add a
row to the real-set table above, and state the measured sync cost in the PR.
