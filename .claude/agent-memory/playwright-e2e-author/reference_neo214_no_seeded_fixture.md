---
name: neo214-no-seeded-fixture
description: NEO-214 removed the Admin Tools panel, the scripted reset replaced the button, and there is no seeded team/player fixture any more — every spec makes its own per-attempt rows
metadata:
  type: project
---

# NEO-214 — no Admin Tools panel, no seeded team/player fixture

**Fact.** The `AdminTools` panel on `/admin/set-builder` ("Reset Set Builder Data", "Seed
Test Teams", "Wipe Legacy Base Children") was deleted, along with `teams.seedTestTeams`
and the public `selectorOptions.resetSetBuilderData` action. The reset is now a scripted
CLI step (`e2e-baseline.sh reset` calling `selectorOptions:resetSetBuilderDataFromCli`,
still gated by `ALLOW_RESET_SET_BUILDER_DATA`) that the CI seed job runs BEFORE the
`setup` project. There is no seed step for teams or players at all.

**Why:** Jason, 2026-09-03: "those should just not be there in production. If we want to
do either of those it should be a scripted admin task, not something in the UI that any
admin can hit." And 2026-09-04, on the seed: delete it entirely, "we can use admin/teams
and admin/players to create teams and players."

**How to apply:**
* The seed lands on `/admin` (the hub), not `/set-selector`: the deployment is already
  empty when it lands, and the Sports column auto-syncs on first mount, so landing on
  the cascade would race that sync against the BSC/SL credential warm-ups, which 503
  under concurrent logins.
* `teams` and `players` are EMPTY at the start of every run and nothing seeds a shared
  fixture. Every spec creates its own.
* Team creation is TeamPicker's `+ Create` row only (`Create team <name>` calling
  `teams.findOrCreate`, which also schedules a Wikidata enrichment on INSERT, so a
  created team is a small outbound cost). `/admin/teams` has **no** create control by
  design. (Later superseded in shape by the New Team dialog; see the project rule.)
* Name teams **per-worker AND per-attempt**: the create row renders only while no team
  of that name exists, so a leftover row from a prior attempt makes the picker show `Add
  <name>` and the spec reaches for a control that is not there. Register the prefix in
  `SET-REGISTRY.md` ("Team names") in the same commit.
* A spec needing a team's **colours** must create the team in a picker and then colour it
  on `/admin/teams`. The only picker outside the set-builder cascade is the
  `/admin/players` career-history editor, so such a spec also creates a throwaway
  player to reach it.
* On `/admin/teams`, an empty Primary-colour box answers to its PLACEHOLDER (`#01214b`),
  so `getByPlaceholder(...)` is both the handle and, with `toHaveValue("")`, the "no
  colours yet" assertion.

## Traps (CI run, 2026-09-xx)
**1. On `/admin/players` the TeamPicker's "+ Create" row may be unreachable.** The career
editor is the last thing on the panel, so the popover (`absolute top-full`) can render
its create row below the viewport with no page left to scroll. Playwright scrolls into
view itself, but a row clipped by the popover's own container can still miss; prefer the
keyboard path the component supports (Enter takes the highlighted match or else creates),
after asserting `No matches.` so the assertion proves Enter means create.

**2. `CareerTeamEntry`'s suggestion dropdown overlays the controls below it** and closes
only on pick / successful add / Escape. Suggestions come from `teams.search`, a Convex
SEARCH index: it matches on TOKENS, not substrings. Build such names from the provided
single-token attempt value (`env.ATTEMPT_TOKEN`), never from a hyphenated `ATTEMPT_ID`,
because every spec sharing a token (`a1`) would suggest each other's rows (GUIDE "Minted
names are single tokens").

**3. A column footer (`Sync Years`) is not "always visible".** It sits below the rows of
a populated column; scroll it into view (or assert `toBeInViewport` after
`scrollIntoViewIfNeeded`) rather than asserting it in place.

See [[patterns_per_worker_data_isolation]].
