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

**No other real set exists in the suite.** If a flow needs marketplace-backed
data that isn't in the table above, it must either sync it itself (and accept the
30–90s cost, with owner approval) or — far more often the right answer — use a
per-worker custom set (see below).

### READ-ONLY means read-only

No flow other than `setup.yaml` may add, edit, or delete cards, players, teams,
or variants on a real set. This is not a style preference: the E2E work queue
drains dynamically across 8 parallel runners, so any write to a shared set is
visible to whichever other flows happen to be running at that moment.

`fetchCardChecklist`'s custom-card pending-name pass reads **all** custom cards on
a `selectorOptionId` **globally** — there is no author scoping. A custom card
added to a shared set therefore seeds *other* workers' entity-review batches.

This was violated by `checklist-fetch-cancel-dialog` and
`checklist-keyboard-only-dialog`, which added cards `9001-*` / `9002-*` to
2024 Topps Chrome Base on every attempt and never cleaned up. CI run
`30505189226`: the cancel flow (runner 4) left `CDPlayerA/CDPlayerB-r4-a1-27829`
behind at 01:30:33; 91s later the keyboard flow (runner 2) opened its wizard on
3 unknowns instead of its own 1 and failed. Accumulated junk also showed up
directly in the UI — "Cards (337)" against "Found 335 cards". Both flows are now
on per-worker custom sets. `NEO-109` (read-only `signed-by-autofills-from-players`
failing on card #300) is very likely the same pollution.

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
private `selectorOptionId`. Two flows additionally suffix `-${ATTEMPT_ID}` where
a retry must not observe its own prior debris.

| Prefix | Owning flow |
|---|---|
| `attr-edit-` | `set-attributes-edit.yaml` |
| `cag-` | `card-autograph-always-visible-saves.yaml` |
| `cap-` | `card-autopopulates-features.yaml` |
| `ccrud-` | `custom-card-crud.yaml` |
| `cd-` | `card-detail-panel.yaml` |
| `cft-` | `card-features-editor-toggle.yaml` |
| `clt-` | `custom-card-row-opens-panel-with-autotitle.yaml` |
| `cte-` | `checklist-fetch-wizard-add-career-team.yaml` |
| `fcd-` | `checklist-fetch-cancel-dialog.yaml` |
| `fp-` | `features-propagation.yaml` |
| `kod-` | `checklist-keyboard-only-dialog.yaml` |
| `lce-` | `checklist-fetch-unknown-entities-link-existing.yaml` |
| `parallel-feature-` | `cards-parallel-custom.yaml` |
| `pg-cancel-` | `parallel-grouping-cancel-discards.yaml` (also `-${ATTEMPT_ID}`) |
| `pg-move-` | `move-parallels-of-inserts-custom.yaml` |
| `pg-reject-` | `parallel-grouping-reject-parallel.yaml` (also `-${ATTEMPT_ID}`) |
| `pp-` | `player-picker-create-custom-card.yaml` |
| `tp-` | `team-picker.yaml` |
| `tpc-` | `team-picker-create-custom-card.yaml` |
| `vme-insert-` | `variant-metadata-editor-insert.yaml` |
| `WOSet3-` | `new-chain-autopopulates-features.yaml` (under synthetic `E2E Test Sport N`) |
| `xag-`, `xsrc-` | `cross-release-card-appears-in-guest-checklist.yaml` |
| `xbg-`, `xbs-` | `cross-release-import-reports-missing-numbers.yaml` |
| `xcg-`, `xsrc-` | `cross-release-hide-toggle-filters-guest-cards.yaml` |
| `xdg-`, `xds-` | `cross-release-unlink-keeps-card-in-home-set.yaml` |

`xsrc-` is intentionally shared between the two cross-release flows that both
need the same guest-source set; it is still per-worker.

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
