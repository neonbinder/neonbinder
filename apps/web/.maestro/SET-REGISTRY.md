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
| Baseball → 1996 → Score → Score | `Insert` (reconciled in-flow, NOT pre-synced) | `flows/set-selector/inserts-1996-score-one-nb-set-two-bsc-sources.yaml` — **sole writer** |
| Hockey → 2024 → Topps → Topps NHL Sticker Collection | none — the flow never goes below `Variant Types` (NOT pre-synced) | `flows/set-selector/set-rename-survives-resync-and-suggests-bsc-name.yaml` — **sole writer** |

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

A custom Set node makes its whole subtree custom (`isCustomSubtree`, NEO-22),
which short-circuits BSC and SportLots before any fetch — so a custom set has no
marketplace id to match on, no marketplace label to disagree with our name, and
no forced sync worth forcing. The feature only exists where a real marketplace
holds an opinion about what the row is called.

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
  only across `MAESTRO_NO_DEPS=1` local re-runs.
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

It was briefly split into a `provides:`/`requires:` pair. That was wrong: CI does
NOT use the dep-graph scheduler. `run-e2e-queue.sh` enqueues in LPT order
(alphabetical without timing history) and 8 runners claim from a shared queue
with no dependency handling — `requires:`/`provides:` are the LOCAL picker's
feature only. Any flow in that queue must be independent of every other.
Keeping it out of `setup.yaml` also means its sync cost is paid by one flow
rather than added to every run's seed.

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

It cannot use a custom set: a custom subtree is short-circuited before any
marketplace fetch (`isCustomSubtree`, NEO-22), so it produces no candidates, and
`CardChecklist` deliberately skips the pairing dialog when all three buckets are
empty. The dialog is only reachable with real marketplace data.

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

Do not re-create them against a custom subtree: it cannot produce an unknown
name any more. See `todos/neo-220-221-e2e-fixture-plan.md` for the post-NEO-239
conditions under which the back-and-resume reload path could return.

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

A **custom Set node makes the whole subtree custom** (`isCustomSubtree` → BSC/SL
skipped, NEO-22), so it costs no marketplace sync at all. This is the default
choice for any flow that needs to write.

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
`+ Create` row (`id: "Create team <name>"` → `teams.findOrCreate`), on whichever
screen the flow is already standing. `/admin/teams` has no "add a team" control
by design — it edits teams, it does not invent them — so a flow that needs a
team's COLOURS creates the team in a picker first and then colours it there.

**NEO-236 — a team name is now two columns.** `location` ("San Diego") is
optional and `name` ("Padres") is the nickname; the name the product shows
everywhere except the two admin master rows is the two composed. A prefix in
the table below is a NAME, and every flow here leaves Location EMPTY, so the
full name and the short name are the same string and every existing matcher is
unchanged. **`admin/team-management-edit-a-team.yaml` is the one exception**:
it types `Loc${WORKER_INDEX}` into the Location box, so from the moment it
saves, its team answers to `Loc<w> TMT-<w>-<attempt>` (heading, picker option,
chip, `Saved …` line, master-row `aria-label`) while the master row still
PRINTS `TMT-<w>-<attempt>`. Any new flow that sets a Location must register it
here the same way, because the composed string is what every other surface
matches on.

Two consequences worth knowing before writing a picker step:

* The typeahead matches and de-duplicates on the COMPOSED name, so typing a
  full name finds a split row and suppresses `+ Create`. Reach for
  `id: "Add <full name>"`, not `id: "Create team <full name>"`, once a row with
  that composed name exists.
* The `+ Create` row is a two-field FORM now (Location, Team name, a preview,
  then the button), which grew the popover from 112px to 261px. In a scroll box
  shorter than that the button is clipped and a tap on it silently misses — see
  the note on `checklist-attention-walker-missing-team.yaml` below. Where the
  picker sits inside a small dialog, create with `pressKey: Enter` on the search
  input (guarded by `assertVisible: "No matches."`) instead of tapping the row.

| Prefix | Owning flow | Shape |
|---|---|---|
| `CNAA-`, `CNAB-` | `checklist-attention-badge-and-filter.yaml` | `-${WORKER_INDEX}-${ATTEMPT_ID}` |
| `CNWT-` | `checklist-attention-walker-missing-team.yaml` | `-${WORKER_INDEX}-${ATTEMPT_ID}` |
| `NBTeam-` | `team-picker-create-custom-card.yaml` | `-${ATTEMPT_ID}` |
| `PMT-` | `admin/player-management-add-and-career-history.yaml` | `-${WORKER_INDEX}-${ATTEMPT_ID}` |
| `SLA-`, `SLB-` | `spine-label/player-team-colors-default-to-longest-tenure.yaml` | `-${WORKER_INDEX}-${ATTEMPT_ID}` (coloured `#132448` / `#002d72`) |
| `TLF-` | `checklist-title-length-limits-and-fixer.yaml` | `-${ATTEMPT_ID}` — kept SHORT on purpose; the name lands in a generated listing title measured against an 80-character cap |
| `TMT-` | `admin/team-management-edit-a-team.yaml` | `-${WORKER_INDEX}-${ATTEMPT_ID}`, and the ONLY team in the suite with a `location`: `Loc${WORKER_INDEX}`, so its composed name is `Loc<w> TMT-<w>-<attempt>` |
| `TPT-` | `team-picker.yaml` | `-${ATTEMPT_ID}` |

**Always per-ATTEMPT, not just per-worker.** `+ Create <name>` is offered only
while no team of that name exists, so a name a previous attempt left behind
renders `Add <name>` instead and the create step reaches for a control that is
not there. (`ATTEMPT_ID` is `w<worker>-a<attempt>-<random>`, so it already
carries the worker; the flows that also prefix `${WORKER_INDEX}` do so for
readability in a failure screenshot, not for uniqueness.)

Players follow the same rule — `players` is global and equally empty. The two
flows that create one name it `PM-`/`SLP-` + `${WORKER_INDEX}` + `${ATTEMPT_ID}`,
plus the throwaway `TME-` that `team-management-edit-a-team.yaml` needs in order
to reach a career editor at all.

## Read-only consumers of the shared real set

These flows drill to 2024 Topps Chrome and only read. They are the reason the set
must stay pristine.

- `base-mapping-cancel-recovers.yaml`
- `checklist-bsc-team-enrichment.yaml`
- `checklist-renders-rich-fields.yaml`
- `multi-source-panel-opens-dialog.yaml`
- `sets-base.yaml`
- `sets-resync-already-loaded.yaml`
- `signed-by-autofills-from-players.yaml`
- `topps-chrome-add-feature.yaml`
- `topps-chrome-marketplace-read.yaml`

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
