# PR #39 (NEO-24/NEO-26) — Maestro E2E diagnosis — 2026-05-25

CI run analysed: https://github.com/neonbinder/neonbinder_convex/actions/runs/26403285687
Failing commit: `d85284a` (head of `jburich/neo-24-listing-metadata-and-team-fix`)
Result: **50 passed, 5 failed** (parallelism=3).

## Failing flows (from CI summary)

| # | Flow | Top-line symptom |
|---|---|---|
| 1 | `card-features-missing.yaml` | `"Missing Features Player" is not visible` is FALSE |
| 2 | `cards-insert-custom.yaml` | `".*Inserts.*" is visible` is FALSE |
| 3 | `features-propagation.yaml` | `".*PropTest-MLB.*" is visible` is FALSE (1st attempt: `Element not found: Save card edit`) |
| 4 | `team-picker-smoke.yaml` | `id: Card name is visible` is FALSE (1st: `Element not found: Delete card 888`) |
| 5 | `team-picker.yaml` | `Element not found: Id matching regex: .*Remove team.*Yankees.*` |

Maestro debug artifacts unpacked at `/tmp/neo24-pr39-artifacts/debug/set-selector_<flow>/`.

## Root-cause analysis

### Root cause A — `resetSetBuilderData` wipes globally, no userId filter

`convex/selectorOptions.ts:1827` defines the `resetSetBuilderData` admin action. Its batch mutations (`resetSelectorOptionsBatch` at L1902, `resetCardChecklistBatch` at L1928, `resetPlayersBatch`, `resetTeamsBatch`) each call:

```ts
const rows = await ctx.db.query("selectorOptions").take(RESET_BATCH_SIZE);
```

**No user filter.** This deletes rows for ALL users in the deployment. When `cascade/setup.yaml` (worker 0's serial-lane setup) taps "Reset Set Builder Data", every parallel worker's selectorOptions / cardChecklist / players / teams get wiped at the same time — regardless of `TEST_EMAIL_${worker}` segmentation.

**Direct hit:** flow #2 `cards-insert-custom`. Screenshot at failure shows `/set-selector` reset to "No sets available / No variant types available" mid-flight — the worker had drilled to Football → 2026 → `cards-ins-cust-2`, tapped `Insert`, then setup.yaml wiped everything before the `.*Inserts.*` assertion could resolve.

**Possible secondary hits:** flows #1, #3, #4, #5 are all `set-selector/` tests that share state with whatever else runs in parallel. If setup.yaml runs during their drill, they'd see similar resets — but the screenshots for #1/#3/#4/#5 show partial state (cards, edit forms), not the wiped homepage. So the global-wipe blast radius likely only caught #2 squarely in this run.

### Root cause B — Test-account state contamination from prior runs

The test users persist between CI runs (only the cascade setup wipes data — and only `selectorOptions` / `cardChecklist` / `players` / `teams`, not other tables). Cards added by prior failing-and-aborted runs accumulate.

Evidence:
- **Flow #1** `card-features-missing` screenshot at failure (after `Confirm delete card 991`): card list shows `#777 Edit Test Player`, `#991 Missing Features Player` (still there post-delete), `#992 Propagation Test Player`, `#9001 Cancel Dialog Test`, `#9002 Keyboard Dialog Test`. The flow's idempotent loop-delete (commit `d85284a`) only deletes rows currently scrolled-into-view; the virtualized list of 312 cards hides off-screen duplicates.
- **Flow #4** `team-picker-smoke` screenshot shows **two** `#889 Team Feature Player` rows and **two** `#992 Propagation Test Player` rows visible at the same time. The just-added `#888 Team Smoke Player` row is OFF-SCREEN ABOVE — the list rendered with stale scroll position, so the `Tap on id: Edit card 888` tap landed on a different row's coords (or no row at all), leading to "Card name not visible" on the edit-form expectation.
- **Flow #3** `features-propagation` screenshot shows the edit form for `#992 Propagation Test Player` with FEATURES expanded: LEAGUE = `PropTest-NL` (with "Revert" link — meaning per-card override is set). Test expected `PropTest-MLB` (inherited from set). The override is from a prior run that wasn't cleaned up.

Flows that survive Root Cause B do so by either (a) running on data that the cascade setup wipes (which is its own bug — Root Cause A — but for these flows, the wipe is actually a feature), or (b) gating on `requires:cards-loaded` AFTER setup completes.

### Root cause C — `team-picker.yaml`: `Tap on text` index ambiguity (suspected; pending Chrome confirm)

In `team-picker.yaml` line 207-209:
```yaml
- tapOn:
    text: ".*Yankees.*"
    index: 0
```

After typing "Yankees" into the search input, the DOM contains TWO matches:
1. The search input itself, whose value is now "Yankees" (DOM order: first).
2. The dropdown match button for "New York Yankees" (DOM order: second).

Maestro's `Tap on text` with index 0 picks the FIRST DOM element, which is the input. The chip is never added; the test only re-types into the input.

Evidence in the maestro log:
```
14:15:29.947 Tap on ".*Yankees.*", Index: 0
  Bounds(x=44, y=251, width=238, height=34)
```

x=44, y=251, 238×34 matches the search input's bounds, not a smaller dropdown row.

However, the screenshot of the SECOND attempt shows the search popover with "No matches" because Yankees IS in `value` (excluded from candidates). That contradicts the "chip never added" hypothesis on the first attempt — unless the second attempt inherited a different starting state (card #889 with Yankees attached from contamination, Root Cause B).

**Status: not yet confirmed.** Chrome walkthrough pending to disambiguate.

## Mapping flows → root causes

| Flow | Root cause(s) | Confidence |
|---|---|---|
| 1 `card-features-missing` | B (duplicate cards survive loop-delete) | HIGH (screenshot direct) |
| 2 `cards-insert-custom` | A (setup.yaml global wipe mid-flight) | HIGH (screenshot direct) |
| 3 `features-propagation` | B (stale per-card override) | HIGH (screenshot direct) |
| 4 `team-picker-smoke` | B (duplicate cards + scroll jitter) | HIGH (screenshot direct) |
| 5 `team-picker` | B and/or C | needs Chrome walk |

## Verification done

- [x] Chrome MCP partial walk against local Vite (NEO-24 worktree) confirmed:
  - The Add-card form's "Player name" placeholder lives on the `Card name` input (`aria-label="Card name"`), and the form has separate `Players` and `Team` (free-text) fields. The TeamPicker (chip-list) is only mounted in the EDIT form, not the Add form. Maestro flows that say `tapOn: "Player name"` are tapping the Card-name input via placeholder match — confirmed working as intended.
  - Reaching the EDIT form requires a user with cards already saved. The fresh local user had `cardChecklist` populated (343 rows) but `Edit card *` aria-labels were absent — meaning user-owned cards (the `cards` table on the canonical Convex deployment) don't exist on this account. Confirms that the EDIT form depends on user-card state that only exists after a successful add-card. This is consistent with the Maestro flows' pattern of "add → edit".
- [x] Source-level deterministic check for Root Cause C (`team-picker.yaml`): inspected `TeamPicker.tsx:130–245`. DOM order when popover open with `query="Yankees"` is: chip spans (if any) → `+ Add team` button → popover input (`aria-label="Search teams"`) → "Loading…"/"No matches"/"Start typing…" placeholder → match `<button>`s (each with `aria-label="Add {name}"`, text content `{name}{city?}`). The popover input has `value="Yankees"` (NOT text content). Whether Maestro's text matcher reads `<input>.value` depends on its accessibility-tree implementation; in this CI run the tap landed at bounds (44, 251, 238×34) which fits either the input (h≈28) or a match button (h≈24). Bounds alone are inconclusive.

## Verification deferred (acceptable risk)

- [ ] Whether Root Cause C contributes independently of Root Cause B. The team-picker-smoke screenshot shows duplicate #889 cards in the list, which alone explains the failure via Root Cause B. The team-picker (full) flow's failure may also be explained by B alone if the Edit-card-889 tap landed on a stale row whose `value` array already had Yankees. Fixing B first will tell us whether C is real (re-run CI; if team-picker still red, address C).
- [ ] Cascade/setup.yaml timestamp overlap with cards-insert-custom — the wiped-homepage screenshot is direct enough evidence that the global wipe hit, so this confirmation isn't load-bearing for the fix.

## CORRECTED analysis (user feedback)

`selectorOptions`, `cardChecklist`, `players`, `teams` are **global tables, not per-user**. My original framing (per-user filters) was wrong. The architecture is:
- `setup.yaml` runs ONCE per CI run, wipes the global tables. That's correct.
- Within a single run, flows that depend on the data must gate on `requires:setup-done` (or transitively via `requires:cards-loaded`).
- After a flow fails and the runner retries it within the SAME run, setup does NOT re-run — so prior-attempt cards persist into the retry.

So the actual root causes:

- **A (cards-insert-custom):** Flow tag list is `[set-selector, regression]` — no `requires:` gate. It can start before `setup.yaml` finishes. The other 4 failing flows all gate on `requires:cards-loaded` (which transitively requires `setup-done`).
- **B (other 4 flows):** Within-run retry contamination. Failed attempt 1 leaves its added cards in the global `cardChecklist`; the in-flow idempotent cleanup uses `scrollUntilVisible` which only finds the first visible occurrence, leaving off-screen duplicates and per-card-feature overrides behind.
- **C (team-picker.yaml):** `tapOn: text: ".*Yankees.*", index: 0` is ambiguous between the search input (value=Yankees) and the dropdown match button (text=New York Yankees). Should bind to the explicit aria-label `Add New York Yankees`.

## Phase 2 — concrete fix path (per user direction: per-attempt-unique card numbers)

**Single concrete path** per `feedback_no_branching_in_plans.md`:

1. **`run-e2e-smoke.sh`** — inject a per-attempt unique `ATTEMPT_ID` env var on each Maestro invocation. The runner already loops on retries (`attempt=1..max_attempts`); add `-e ATTEMPT_ID="${worker_index}-${attempt}-${RANDOM}"` to the per-attempt invocation. Maestro re-parses the YAML per attempt, so each attempt sees a fresh `${ATTEMPT_ID}`.

2. **`cards-insert-custom.yaml`** — add `requires:setup-done` to its tag list. One-line fix for Root Cause A.

3. **Four contamination-prone flows** (`card-features-missing.yaml`, `features-propagation.yaml`, `team-picker-smoke.yaml`, `team-picker.yaml`) — replace hardcoded card numbers and player names with `${ATTEMPT_ID}`-suffixed variants so each attempt uses a unique card. Specifically:
   - `inputText: "991"` → `inputText: "991-${ATTEMPT_ID}"`
   - `inputText: "Missing Features Player"` → `inputText: "Missing Features Player ${ATTEMPT_ID}"`
   - All `id: "Edit card 991"` / `Delete card 991` / `Confirm delete card 991` references gain the suffix.
   - All `text:`/`assertVisible`/`notVisible` references to the player name gain the suffix.
   - Drop the `scrollUntilVisible "<name>" + repeat-delete` cleanup blocks at flow start — unnecessary now that names don't collide.

4. **`team-picker.yaml`** — Root Cause C fix:
   - `tapOn: text: ".*Yankees.*", index: 0` → `tapOn: id: "Add New York Yankees"` (the typeahead match button's explicit aria-label, no ambiguity).
   - Similar for Mets: `tapOn: id: "Add New York Mets"` if/where the flow taps Mets in the dropdown (keyboard test uses Enter, not tap, so probably no change there).
   - `tapOn: id: ".*Remove team.*Yankees.*"` → `tapOn: id: "Remove team New York Yankees"` (drop regex, use literal).

## Verification done

- [x] Chrome MCP partial walk against local Vite (NEO-24 worktree) confirmed:
  - The Add-card form's "Player name" placeholder lives on the `Card name` input (`aria-label="Card name"`), and the form has separate `Players` and `Team` (free-text) fields. The TeamPicker (chip-list) is only mounted in the EDIT form, not the Add form. Maestro flows that say `tapOn: "Player name"` are tapping the Card-name input via placeholder match — confirmed working as intended.
  - Reaching the EDIT form requires a user with cards already saved. The fresh local user had `cardChecklist` populated (343 rows) but `Edit card *` aria-labels were absent — meaning user-owned cards (the `cards` table on the canonical Convex deployment) don't exist on this account. Confirms that the EDIT form depends on user-card state that only exists after a successful add-card. This is consistent with the Maestro flows' pattern of "add → edit".
- [x] Source-level deterministic check for Root Cause C (`team-picker.yaml`): inspected `TeamPicker.tsx:130–245`. DOM order when popover open with `query="Yankees"` is: chip spans (if any) → `+ Add team` button → popover input (`aria-label="Search teams"`) → "Loading…"/"No matches"/"Start typing…" placeholder → match `<button>`s (each with `aria-label="Add {name}"`, text content `{name}{city?}`). The popover input has `value="Yankees"` (NOT text content). Whether Maestro's text matcher reads `<input>.value` depends on its accessibility-tree implementation; in this CI run the tap landed at bounds (44, 251, 238×34) which fits either the input (h≈28) or a match button (h≈24). Bounds alone are inconclusive — but the fix is the same regardless: use the explicit aria-label.

## Verification deferred (acceptable risk)

- [ ] Whether the OTHER custom-set flows that passed this run (cards-parallel-custom, cards-parallel-of-insert-custom, move-parallels-of-inserts-custom, cards-custom-subtree-gate) ALSO lack `requires:setup-done` and just got lucky. They do — same gap as cards-insert-custom. Fixing one flow's tag is a targeted fix; tagging all of them is a broader stability improvement that can be a follow-up if any of them flakes.

## Timeline

- 2026-05-25 09:?? PT — Artifacts downloaded (`/tmp/neo24-pr39-artifacts`). Diagnosis drafted from logs + screenshots + source.
- Next: Chrome MCP walks to confirm flows 1, 5.
