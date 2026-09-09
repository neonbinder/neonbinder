---
name: reference_neo102_card_attention_walker
description: "NEO-102 needs-attention badge / header chip+filter / CardAttentionWalker + MissingTeamFixer — exact selectors, why a per-ATTEMPT_ID custom set is required for the exact-count assert, the TeamPicker-popover occlusion trap on the fixer's Save button, and the hard local-dev wall (new Convex functions absent on shared dev ⇒ whole-SPA error boundary)"
metadata:
  type: reference
---
> **STALE FLOW NAMES (2026-09-05).** Every `checklist-fetch-*` /
> `checklist-keyboard-only-dialog` flow named below was DELETED in NEO-220/221 —
> quick-add's Players field is a PlayerPicker, so a custom subtree can no longer
> produce an unknown name. The wizard mechanics here are still accurate; the flow
> names are history. See [[reference-neo220-wizard-only-from-real-fetch]].

# NEO-102 — "needs attention" badge, chip + filter, and the attention walker

Two flows, both `set-selector` + `regression`, both on a per-worker **and
per-attempt** custom set under REAL `Baseball / 2024 / Topps`:

| flow | set prefix | what it proves | provable locally? |
|---|---|---|---|
| `checklist-attention-badge-and-filter.yaml` | `cna-` | row badge, exact header count, filter toggle | **YES — green in 3m34s** |
| `checklist-attention-walker-missing-team.yaml` | `cnw-` | walker: Skip / pick-a-team / "No team on this card" + reload persistence | **NO — needs a PR Convex preview** |

## Selectors (all verified against the components; the badge/chip set verified live)

- **Row badge** — a single amber `!` glyph, so everything is in its
  `aria-label` (→ Maestro `id:`):
  `id: "Card <cardNumber> needs attention: no team on this card yet"`.
  A colon in a MATCHER is fine (only flow `name:` fields are character-restricted).
- **Header chip** — `text: "<N> need attention"` (the count is the label, so the
  text IS the assertion) and `id: "Show only cards needing attention"`; when the
  filter is ON the accessible name becomes `… (on)`, so the off-tap and the
  on-tap target **different** ids — which is itself the proof the toggle toggled.
- **Walker link** — `text: "Fix them one at a time"` (its aria-label carries the
  count, `Fix cards needing attention one at a time (2)`, so match on the text
  to stay count-agnostic).
- **Walker** — `"Cards Needing Attention"` (h2); progress `<p role="status">`
  renders `2 cards need attention · 0 fixed` — match it as
  `".*2 cards need attention . 0 fixed.*"` (the `.` covers the middot without
  typing U+00B7); footer `id: "Skip card <cardNumber> for now"` — **the only
  card-specific handle in the dialog, so it is how you prove the walker is on
  the card you expect**; close button text flips `"Close (Esc)"` →
  `"Done (Esc)"` when nothing is left; all-clear step
  `"All clear — nothing on this checklist needs attention."`
- **MissingTeamFixer** — `"No players on this card."` (a custom card carries
  pending player NAMES, never linked player rows, so this is the deterministic
  state); hint `"Pick at least one team, or record that this card has none."`;
  `text: ".*Save & Next.*"`; `"No team on this card"`; suggestion chips are
  `id: "<team> (from <player>'s career)"`. TeamPicker inside it uses its usual
  `Add team` / `Search teams` / `Add <name>` / `Remove team <name>` ids.

## The walker's queue order IS deterministic — don't hand-roll around it

`getCardChecklist` returns rows **already sorted by `compareCardNumbers`**
(`selectorOptions.ts`, merged home+guest rows then `.sort`), and the walker
seeds `pinnedId` from the first flagged row of that same list. So with #801 and
#802 both flagged the walker opens on **#801**, every time. That is what makes
a two-card flow (skip the first, answer the second) assertable.

## Why these flows need a per-ATTEMPT set, not just per-worker

They assert an **EXACT** attention count (`"2 need attention"` →
`"1 need attention"`). An exact count is only knowable on a checklist the
attempt built from empty, so `SET_NAME: "cna-${WORKER_INDEX || 0}-${ATTEMPT_ID}"`.
Bonus: the drill util's `when: notVisible: ${SET_NAME}` guard is FAST-true for a
name that has never existed, where a reused name burns the full ~7s optional
lookup (R10).

## The add-card form's "Team (optional)" does NOT clear the badge

`handleAddCard` sends the typed team as `teams: [name]` → **pendingTeamNames**,
which only becomes a `teamOnCardIds` link after a sync + unknown-entities
confirmation. `deriveCardAttention` reads the LINK. So a custom card created
with that field filled is still badged "no team on this card yet". Use it as a
deliberate no-op if you want; use the **card drawer's TeamPicker + Save card
edit** (drawer position 2, no in-drawer swipe needed) when you need a row that
genuinely has a team.

## TRAP — TeamPicker's popover overlays the fixer's own Save button

`TeamPicker` closes its typeahead popover **only on Escape** (no outside-click
handler, and `addChip` deliberately keeps it open for multi-team cards). In the
card DRAWER that is harmless — Save lives in a sticky footer. In
`MissingTeamFixer` the popover (`absolute left-0 top-full w-64 z-10`, anchored
to the `+ Add team` trigger) hangs directly over the `Save & Next` /
`No team on this card` row. maestro-web taps with a **real Selenium
PointerInput at viewport coordinates** (`CdpWebDriver.tap` → `scrollToPoint` +
`Sequence(PointerInput…)`, confirmed by javap), so an occluded tap lands on
whatever is topmost — i.e. on a team option, silently adding a second team.

What saves the tap is HORIZONTAL offset: the popover's left edge sits at the
trigger, which the freshly-added chip pushes ~130px right, while `Save & Next`
is centred ~85px from the fixer's left edge. So: **wait for
`id: "Remove team <full name>"` before tapping Save** — that both proves the
pick landed and guarantees the chip has resolved to its full-width label rather
than the transient `Loading…` (which is ~55px and would shrink the margin to
almost nothing).

Product finding raised with NEO-102: a mouse-only operator hits the same wall
(their click on Save lands in the popover), and Escape is not an option in that
dialog because Escape means "defer" to the walker. The fix belongs in the
component (close on select inside the fixer, or an outside-click close).

## HARD local-dev wall — a new Convex function turns into a blank page

Local E2E runs local Vite against **shared dev Convex, which tracks `main`**.
`MissingTeamFixer` calls `useQuery(api.cardChecklist.suggestedTeamsForCard)`;
on a deployment without that function the query THROWS during render and the
whole SPA falls to its top-level boundary. The failure hierarchy is a single
node:

```
{"text": "An error occurred. Please refresh the page.", "bounds": "[0,0][1024,24]"}
```

So the symptom is "the dialog never opened" (`Assertion is false: "Cards
Needing Attention" is visible`) with a **one-line page**, NOT a missing
selector. Anything that renders a not-yet-deployed backend function is
CI-preview-only; split the coverage so the surfaces that are pure client-side
derivations (this feature's badge / count / filter all are) live in their own
flow that CAN go green locally.

## What no E2E flow can reach here

Clause 3 of the rule ("a BSC-linked card is not badged until `teamCheckDoneAt`
lands") and the walker's auto-open-after-commit both need a real
marketplace-backed card. Real sets are read-only (R7a) and a custom subtree
skips BSC entirely (NEO-22), so both are unit/component-covered only — the same
wall documented at length in `checklist-bsc-team-enrichment.yaml`'s header.
Preselected suggestion chips need a LINKED player with career years for the
set's year, which only the entity-review wizard path produces
(`checklist-fetch-wizard-add-career-team`, ~3.5 min) — see
[[reference_neo92_career_team_entry]].
