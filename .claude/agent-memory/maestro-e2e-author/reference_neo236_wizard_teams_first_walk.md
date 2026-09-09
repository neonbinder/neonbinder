---
name: neo236-wizard-teams-first-walk
description: "NEO-236 entity-review wizard: teams are presented before players and a walk-picked player row YIELDS whenever any team row settles — so a flow must wait out the lookups and drain team steps before it can act on a player. The two walk utils that do it, and the selectors that are and are not stable."
metadata:
  type: reference
---

# The wizard never opens on a player row, and will take one back off you

Source of truth: `apps/web/components/SetSelector/entity-review-nav.ts`
(`nextUndecided`, `resolveNav`, `waitingOnStagedTeams`) and
`EntityReviewWizard.tsx`.

Three separate behaviours, all deliberate, that each broke flows in CI run 9 /
local runs on 2026-09-06:

1. **Teams first, always.** `nextUndecided` returns the first settled undecided
   TEAM before considering any player. A fresh batch therefore opens on a
   `New Team: <name>` step — a Location / Name / League form. **No player
   control exists on it, and the `Decided (N)` history list is not rendered on
   a team step at all.** An assertion of `Decided (1)` can fail while the header
   already reads `1 of 116 reviewed`: the decision landed, the list is absent.

2. **An implicitly-pinned player yields to any team that settles.**
   `resolveNav` marks the pin stale when `presented.kind === "player" &&
   !pinnedRowHasEdits && hasSettledUndecidedTeam(rows)`. Lookups run five-wide
   over live Wikidata and finish out of order, so a batch presenting a player
   *now* can have a dozen team rows one round-trip from settling. Observed: the
   walk landed on a player, two drain passes agreed it was a player, and by the
   next Maestro command the screen read `New Team: Brooklyn Dodgers`,
   `0 of 112 reviewed`.
   `pinnedRowHasEdits` = `linkingOpen || careerEntryDirty ||
   stagedCareerTeams.length>0 || an unticked chip || an edited New Team form`.
   That is why the Link flow survives (opening the link search pins the row)
   while a flow that merely asserts does not.

3. **Landing on a fresh player stages its career teams and hands nav to them.**
   The effect keyed on `current` calls `stageCareerTeams`, and on a non-zero
   return resets nav. The write lands a few seconds AFTER the row appears —
   long enough to assert the player row and then tap into a team step.

## The fix: `util-wizard-walk-to-player-row{,-creating-teams}.yaml`

Order matters and all four steps are load-bearing:

1. `extendedWaitUntil: notVisible: ".*still looking up.*"` (timeout 180000).
   `N still looking up — wait or skip` is the wizard's own footer status and is
   absent exactly when no undecided row is pending. R5 marketplace-class
   exception — it is a live Wikidata round-trip per unknown name.
2. `repeat while notVisible id "Skip .* not a person"` → tap the team step's own
   control. Once no row can still settle, draining the teams is terminal.
3. A deliberate dwell for the staging hand-off: `runFlow: when: notVisible:
   "Confirm New Players & Teams"` with a body that never runs. The guard is
   false by construction (the title is always up), so it polls the full window
   and skips. It is the only way to express "wait, then look" that neither
   fails when no hand-off comes nor returns as soon as the screen stops moving.
4. Repeat 1+2, then `extendedWaitUntil visible: id "Skip .* not a person"`.

Two variants because the drain's decisions land in the same `Decided` list the
caller asserts on: the **skip** variant leaves everything "Skipped" (so a
caller's create is the only "Added as new"); the **creating-teams** variant taps
`Add as New Team` (so the one caller that skips owns the only "Skipped").

## Selectors

- **Stable kind discriminator:** `id: "Skip .* not a person"` /
  `id: "Skip .* not a team"` (aria-label is `Skip <name> — not a person|team`;
  the wording never changes for a kind).
- **NOT stable:** `Add as New Player`. Both the visible text and the aria-label
  become `Link to <name>` whenever the row has an exact hierarchy match, so it
  is useless as a "this is a player row" signal.
- The New Team form's Location field shows **"San Diego"** in a Maestro
  hierarchy — that is the input's PLACEHOLDER, not a value. `teamCreatePrefill`
  only fills Location from an ESPN location that whole-word-prefixes the name.
  Do not report it as a leaked value; I nearly did.

## Fixture consumption

A committing wizard flow mints the players/teams it decides, so on a preview
that already ran it the set has no unknown names left and **the wizard never
opens** — the fetch goes straight to "0 new / N checklist reviews in progress".
That is an exhausted fixture, not a flow defect. Only a freshly seeded preview
re-arms it.
