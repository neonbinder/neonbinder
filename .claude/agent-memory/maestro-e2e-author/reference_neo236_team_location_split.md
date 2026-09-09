---
name: neo236-team-location-split
description: "NEO-236 split teams into location + nickname AND moved creating a team into a portalled New Team dialog. What each surface shows, the two-step create sequence and its exact selectors (`New team <typed>` row → dialog → `Create team <full name>`), why the dialog HEADING is unassertable on the tap path, and the post-dialog page-scroll defect."
metadata:
  type: reference
---

# NEO-236 — `teams.location` + `teams.name`

`teams.name` is the nickname ("Padres"); `location` is optional ("San Diego").
Full name = `location + " " + name`, composed by `lib/teams/team-name.ts`
(`teamFullName` / `teamShortName` / `splitTeamName`). Full name EVERYWHERE
except two admin master rows.

## Where the short name shows (only these two)

| Surface | Shows | Handle |
|---|---|---|
| `/admin/teams` master row | SHORT name, location + league on a muted 2nd line | `aria-label` = EXACTLY `teamFullName` → `id: "<full name>"` is the row (the `title` trick from the leagues screen does NOT apply here — this row has no `title`) |
| `/admin/players` master row | team segment = SHORT name | `title={player.name}` still on the name span |

Everything else — picker chips and options, checklist sub-lines, listing
titles, spine labels, the wizard, `Saved <name>.` status lines — is the
COMPOSED name. **`Saved ${draftFullName}.`** is the Team Management save
confirmation, so a flow that types a Location must match
`.*Saved <location> <name>.*`, not `.*Saved <name>.*`.

## Selectors added / changed

* Team Management form: **Location** (placeholder `San Diego`) then **Name**
  (placeholder `Padres`), at the TOP of the form above League and the colours;
  muted `Shows as: <full name>` under them; collision refusal is an inline
  `role="alert"` reading `Another team in this sport is already called <full>`.
  Empty Location answers to `text: "San Diego"` (maestro reports placeholder).
* **Creating a team is TWO steps (final NEO-236 shape).** The popover holds ONE
  create affordance — visible text `+ New team "<typed>"…`, accessible name
  **`New team <typed>`** — and it OPENS `NewTeamDialog` rather than writing.
  The dialog is portalled to `document.body`, `role="dialog" aria-modal="true"`,
  `fixed inset-0 z-[60]` centred, so NO scrolling ancestor can clip it (the
  earlier inline two-field form, its 261px popover and the `scrollIntoView`
  workaround are all GONE). It holds `New team location (optional)`,
  `New team name` (pre-filled with the typed text), a `New team league`
  radiogroup of pills, a `Shows as:` line, and the unchanged
  **`Create team <composed full name>`** button plus `Cancel`.
  Every other pre-existing selector (`Team picker`, `Add team`, `Search teams`,
  `Add <full name>`, `Remove team <full name>`, `Team: <name>`, `No matches.`)
  is unchanged. Matching and create-suppression are on the COMPOSED name.
  * **Gate the dialog on the NAME BOX, never the heading:**
    `assertVisible: { id: "New team name", text: "<typed>" }`. See the heading
    defect below.
  * **Tap `Create team <name>` by `id`; never a second `pressKey: Enter`** —
    Create and Cancel are `NeonButton`s with an identical class string and
    maestro-web re-finds the focused element by an XPath that falls back to
    that class (see [[maestro-presskey-needs-unique-id-on-target]]).
  * Where the picker sits in a short scroll box (attention walker body, the
    bottom of the Players career editor) the ROW is still clipped — open the
    dialog with `assertVisible: "No matches."` + `pressKey: Enter` instead of
    tapping it. The DIALOG is never clipped.
* Entity review wizard: `entity-review-team-location` / `entity-review-team-name`
  ids on a team row; `Career team location (optional)` beside `Career team name`
  (SAME row — no height change); `Location for new team {X}` /
  `Name for new team {X}` per career-team checkbox.

## Two defects found while re-fitting the flows (2026-09-05, local, deterministic)

**1. Opening the dialog BY CLICK wiped the heading's name — FIXED 2026-09-05.**
`TeamPicker.handleRootBlur` early-returned on a STALE `newTeamOpen`; its
`setTimeout(0)` then saw focus in the portal (outside `rootRef`) and ran
`setPopoverOpen(false); setQuery("")`. Since `initialName` is `query.trim()`,
the `<h2>` — the dialog's `aria-labelledby` target — fell back from
`New team: <typed>` to a bare `New team`, and the popover closed behind the
modal. Enter never reproduced it, because Enter does not blur. Fixed with a
synchronous `newTeamOpenRef` mirror read by the blur handler (outside AND
inside its timeout) and by the pointerdown-outside handler. **So both
assertions are safe and both are used:** `assertVisible: "New team: <typed>"`
(the dialog is correctly LABELLED) and
`assertVisible: { id: "New team name", text: "<typed>" }` (it is correctly
SEEDED). Verified green on the click path.

**2. "The page stops scrolling after the dialog" — NOT the dialog. Do not fix
it.** The original attribution came from a control that only separated "opened
a modal" from "opened nothing". Further probing killed it:

* A stage that opened the picker popover and closed it WITHOUT the dialog left
  `/admin/teams` scrolling perfectly afterwards.
* The control block passed 3 runs in a row, minutes apart.
* The same dead-page signature appears with NO dialog anywhere: on a re-visit
  to `/admin/players`, the filter input holds the typed text while the counter
  still reads `8 matches` and every row remains — React never processed the
  change event.
* **Every** failing case wrote a **0-byte** screenshot (`takeScreenshot` hung);
  every healthy case wrote a complete PNG.
* That healthy PNG is **1024×625** while the root div measures **833** tall, so
  the page IS scrollable and the viewport IS what Maestro thinks — this is not
  a CSS scroll lock and not an oversized window.

Read together: the page's main thread / CDP session wedges, so
`Runtime.evaluate` (which is all `swipe` is — `window.scrollTo`) and React's
event processing both stop while `Input.insertText` still lands in the DOM.
Infra artefact, strongly correlated with the leaked-Chrome memory pressure in
[[local-validation-monorepo-worktree]]. **Symptoms to recognise: bounds
identical across every scroll retry + a 0-byte failure screenshot + a
controlled input whose value is present but whose list never filters.** Do not
read those as a product bug.

## Team Management panel — measured vertical order (for `above:`/`below:` anchors)

Centring the `Location` label at y≈315 puts everything in one viewport, with
these tops: counter 210 · master row short name 259 · heading 267 · row's muted
location line 279 · **Location label 315** · Location + Name inputs 339 ·
`Shows as` 389 · Primary colour 542. So `above: {text: "Location"}` isolates the
heading from the `Shows as` preview and the master row from the Name box, and
`below: {text: "Location"}` isolates the Location box from the row's location
line. (`above`/`below` compare TOP EDGES with no x constraint — see
[[patterns-asserting-spatial-order]] — so cross-column anchoring is valid.)

## Behaviour changes that could have broken flows but did not

`resolveTeamIdByName`, `applyBscTeamResolution` and `backfillTeamToOnCardIds`
are MATCH-ONLY now (link or leave; never insert). Teams still get created in
the suite because `setup.yaml`'s "Add All Remaining as New (N)" stages a
Location + Name per team row, and the commit prelude inserts from THAT. So
`checklist-bsc-team-enrichment`'s `Remove team Seattle Mariners` still holds.

## The wizard's team row now OVERFLOWS its dialog — the footer is the only safe target

Second clipping site, same cause, worse consequences (CI run 34007264279, r5,
`inserts-1996-score`). `EntityReviewWizard`'s team row grew past what the
dialog can show, and the primary action is the LAST element in it, so the
action itself falls off. Measured from that run's `step-125` hierarchy at
1024x629:

| | y |
|---|---|
| dialog (`h-[min(40rem,100%)]`, centred) | 16–613 |
| scrolling body (`flex-1 min-h-0 overflow-y-auto`) | …–528 |
| footer (`shrink-0`) — the bulk links | 536–568 |
| the team row's content | 122–652 (~100px too tall) |
| **`Add as New Team`** | **620–652 — below the footer AND below the dialog** |

Tap symptom: `tapOn` aims at (497,636), off the bottom of a 625px window, and
dies with **`null cannot be cast to non-null type kotlin.Int`** — the CDP crash
a scroll-before-tap throws when it has nothing to scroll. **No flow-side scroll
fixes it**: maestro-web's scroll is `window.scrollTo`, which moves the page and
cannot drive an inner `overflow-y-auto` box.

Height breakdown of that row: Wikidata enrichment lines ~70px · NEO-236's
Location+Name+hint+"Shows as" ~120px · and the big one, the league picker
(`entity-review-team-league`) at **250px** — it renders EVERY league in the
sport as wrapping chips and therefore **grows monotonically with the global
`leagues` table**. The run-8 hierarchy shows `LG-4-r4-a1-20866`, a league
`league-management-add-and-edit` created on another runner, sitting in it. So
this gets worse every CI run, and `setup.yaml` / `signed-by-…`, which must
really create their teams, are on the same track.

**Rule: inside this wizard, only the FOOTER is a safe tap target.** `Add
remaining players as new` and `Skip remaining names` are `shrink-0` at y≈544
whatever the row does. Two gotchas when using them:
* both carry `disabled={bulkPending !== null || saving}`, and NEO-221's ARMED
  auto-add sets `bulkPending` in a burst per lookup that lands — so a single
  tap can hit a dead control. Re-tap in a `repeat … while: notVisible
  ".*Confirm & Save.*"`.
* they render under `!allDecided && remainingNames > 0`, so they vanish the
  instant the bulk lands — guard the tap with an inner `runFlow when:`.

A per-row decision (`Add as New (Player|Team)`) is a coin flip: fine on a
player row, clipped on a team row. That cannot be hardened from YAML.

### Resolved in-app — and "Skip remaining names" is NOT the workaround

The clipping above was fixed in the app (`6b6f5f5`): the per-row decision
controls (`Add as New {Player|Team}`, `Link to Existing…`, `Skip … — not a …`,
`Back`) now render in the dialog's **fixed footer** (`shrink-0`), and the
league picker is bounded + collapsible behind "Change league". The accessible
names are called out in the source as an E2E contract. So the per-row
`tapOn: "Add as New Team"` loop is safe again and is what all three flows use.

**Do not substitute the footer's `Skip remaining names` for it.** Tried in CI
run 34010164587: it drained the wizard fine (`Saved 220 cards` passed) and then
broke the flow two steps later. Skipping N names paints a **"Skipped names (N)"
panel on the checklist page** — 23 rows with Unskip buttons, measured
`[72,244][767,976]`, **732px** — which pushes the card list down and out of its
own virtuoso scroller. The next step's `Edit card .* below "BSC source"` then
matched a row at y=225-245 while `virtuoso-scroller` started at **y=280**, i.e.
a row clipped ABOVE its own scroll container; Maestro reports raw
`getBoundingClientRect` and filters only against the browser VIEWPORT, never
against an inner scroller, so it tapped (687,235) — dead space between the
filter row and the skipped panel — and the drawer never opened.

General lesson, worth more than the specific bug: **a bulk "skip" is not a
free way to drain a wizard.** It leaves durable, visible state on the page
behind it, and any later step whose anchor depends on page geometry inherits
it. Draining by making the decisions the flow would otherwise make leaves the
page as the rest of the flow expects.
