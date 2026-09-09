---
name: neo236-new-team-dialog-test-layout
description: NEO-236 team-creation test split (NewTeamForm/NewTeamDialog/TeamPicker/wizard), the staged careerTeamOf fixture recipe, and the RTL getByText direct-text-node gotcha that bites "Shows as: <span>" lines
metadata:
  type: reference
---

# NEO-236 — where team-creation coverage lives, and the fixtures it needs

## The four-file split

Team creation is one shared form rendered by two hosts. Coverage follows that shape,
and duplicating it across files is the thing to avoid:

| File | Owns |
|---|---|
| `NewTeamForm.test.tsx` | the fields, the composed preview, `newTeamPrefill`/`draftFullName` (pure), and the League **radiogroup** — roving tabindex, arrow keys, suggestion resolution |
| `NewTeamDialog.test.tsx` | everything the modal adds: `Create team {composed}` accessible name, focus open/return/trap, Escape+scrim (and their refusal while creating), the `findOrCreate` args, refusals |
| `TeamPicker.test.tsx` | when the `+ New team “{q}”…` row is offered, that pointer/Enter both OPEN the dialog, the popover surviving the portalled modal, and the *wiring* only (typed name in → created id out as a chip) |
| `EntityReviewWizard.test.tsx` | the New Team **step** (same form, `entity-review-team-*` ids) and the player step's career-team **chips**, which report rather than ask |

`CardChecklist.test.tsx` also mounts a real `TeamPicker`, so its quick-add tests need
the two-step create (open row, then the dialog's Create button) and a `leagues.list`
entry in its `api` mock — without that entry `api.leagues.list` throws at render.

## Fixture recipe: a staged `careerTeamOf` team row

`stageCareerTeamRows` writes one team row per career team that has no `teams` row,
and `getBatch` emits them **ahead of** their player. `nextUndecided` holds the player
until each carries a decision — that ordering plus that hold is what produces Jason's
"New Team, New Team, then the player" walk. A wizard fixture must reproduce both:

```ts
const player = makeRow({ kind: "player", name: "Travis Bazzana", enrichment: { careerTeams: [...] } });
const staged  = makeRow({ kind: "team", name: "Sydney Blue Sox",
  source: { kind: "careerTeamOf", playerRowId: player._id } });
currentRows = [staged, player];   // teams FIRST, like the server
```

Chip status depends on **two** sources, both needed:
- `teams.resolveNames` (`currentResolvedNames`) → `existingTeamId`/`existingName` gives `→ {name}`;
- the staged row's own `decision` → `create` gives `→ {composed} (new team, this batch)`,
  `link` (+ `teams.getManyByIds`) gives `→ {linked name}`, `skip`/absent gives
  `needs a team decision` and blocks the primary.

`currentResolvedNames === undefined` is **`checking`**, not `waiting` — it says nothing
and blocks nothing. Leaving it undefined while asserting a block is the mistake.

Because `nextUndecided` skips a player with an undecided staged team, the player's
blocked-primary branch is only reachable in a test by decking a staged row `skip`
(or by an explicit pin).

## RTL gotcha: `getByText` only sees DIRECT text nodes

`<p>Shows as: <span>{preview}</span></p>` — `getByText("Shows as: San Diego Padres")`
matches nothing, because the matcher reads an element's own text nodes, not
`textContent`. Address the paragraph by its literal (`getByText("Shows as:")`) and read
`.textContent`. Same trap for any label + value split across a span.

## `aria-describedby` is a LIST here

`NewTeamForm` joins its own help-line and preview ids with the host's blocked-reason id,
so every describedby assertion on these fields is `toContain`, never `toBe`. Asserting
"the reason is gone" means "no longer contains that id", not "is null".

See [[neo92-entity-review-wizard-test-suite]] for the older wizard fixtures and
[[neo208-shared-helper-test-patterns]] for the stateful TeamPicker mock pattern.
