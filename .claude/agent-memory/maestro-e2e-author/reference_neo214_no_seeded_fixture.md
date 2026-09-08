---
name: neo214-no-seeded-fixture
description: NEO-214 removed the Admin Tools panel, the scripted reset replaced the button, and there is no seeded team/player fixture any more — every flow makes its own per-attempt rows
metadata:
  type: project
---

# NEO-214 — no Admin Tools panel, no seeded team/player fixture

**Fact.** The `AdminTools` panel on `/admin/set-builder` ("Reset Set Builder
Data", "Seed Test Teams", "Wipe Legacy Base Children") was deleted, along with
`teams.seedTestTeams` and the public `selectorOptions.resetSetBuilderData`
action. The reset is now a scripted CLI step (`e2e-baseline.sh reset` →
`selectorOptions:resetSetBuilderDataFromCli`, still gated by
`ALLOW_RESET_SET_BUILDER_DATA`) that `run-e2e-smoke.sh`'s setup mode runs
BEFORE `setup.yaml`. There is no seed step at all.

**Why:** Jason, 2026-09-03 — "those should just not be there in production. If
we want to do either of those it should be a scripted admin task, not something
in the UI that any admin can hit." Then 2026-09-04, on the seed specifically:
delete it entirely, "we can use admin/teams and admin/players to create teams
and players."

**How to apply:**

* `setup.yaml` lands on `/admin` (the hub, gate
  `.*Build set parameters from marketplace data.*`), not `/set-selector`. The
  deployment is already empty when it lands, and the Sports column auto-syncs on
  first mount — landing on the cascade would race that sync against the BSC/SL
  credential warm-ups, which 503 under concurrent logins. The existing
  `openLink /set-selector` mid-flow is the first mount now.
* `teams` and `players` are EMPTY at the start of every run and no flow seeds a
  shared fixture. The Yankees / Mets / "E2E Fixture Player" rows are gone; seven
  flows depended on them and every one now creates its own.
* Team creation is TeamPicker's `+ Create` row only —
  `id: "Create team <name>"` → `teams.findOrCreate` (which also schedules a
  Wikidata enrichment on INSERT, so a created team is a small outbound cost).
  `/admin/teams` has **no** create control by design.
* Name teams **per-worker AND per-attempt**. Per-attempt is mechanical: the
  create row renders only while no team of that name exists, so a leftover row
  from a prior attempt makes the picker show `Add <name>` and the flow reaches
  for a control that is not there. Register the prefix in
  `.maestro/SET-REGISTRY.md` → "Team names" in the same commit.
* A flow needing a team's **colours** must create the team in a picker and then
  colour it on `/admin/teams`. The only picker outside the set-builder cascade
  is the `/admin/players` career-history editor, which means such a flow also
  creates a throwaway player to reach it.
* On `/admin/teams`, an empty Primary-colour box answers to its PLACEHOLDER
  `#01214b` (maestro getNodeText = value ‖ placeholder ‖ aria-label). That makes
  it both the handle and the "this team has no colours yet" assertion.

## Two traps this cost a CI round-trip to find (run 33875599981)

**1. On `/admin/players` the TeamPicker's "+ Create" row CANNOT be tapped.**
The career editor is the last thing on the panel, so at max page scroll
`+ Add team` sits at y=510-532 of the 629px viewport and `centerElement` cannot
lift it — there is no page left to scroll. The popover is `absolute top-full`:
search input y=545-579, first row y=583. **Exactly one row fits.** With no match
the popover renders "No matches." AND the create row beneath it, putting the
create row at y>=609 — off-screen. maestro-web still reports its layout bounds,
so `tapOn` reports COMPLETED while the click lands outside the picker; that is a
pointerdown-outside, so the popover closes and nothing is created.
**Fix: `assertVisible: "No matches."` then `pressKey: Enter`** — TeamPicker's
keydown takes the highlighted match if there is one and otherwise calls
`createAndAdd()`, so the assert is what proves Enter means create. No
coordinates involved. A single MATCH row at y=583-611 is still tappable (proven
green), so `Add <name>` taps are fine; only the create row is out of reach.

**2. `CareerTeamEntry`'s suggestion dropdown is a trap once `teams` is not empty.**
It is `absolute z-10 left-0 right-0`, so one suggestion covers "From year" and
"+ Add" directly below it, and it closes ONLY on pick / successful add / Escape —
and maestro-web has no Escape keycode. A tap aimed at "+ Add" lands on the first
suggestion, which REPLACES the typed name. Suggestions come from `teams.search`,
a Convex SEARCH index: it matches on TOKENS, not substrings. `ATTEMPT_ID` is
`r<runner>-a<attempt>-<random>`, so EVERY flow that names a team after it shares
the token `a1` — including the pre-existing `NBTeam-${ATTEMPT_ID}`.
**Fix: build such names from a separator-free attempt token** —
`- evalScript: '${output.ATTEMPT_TOKEN = String(output.ATTEMPT_ID).split("-").join("")}'`
→ `CareerTeam-r3a123945` is one token nothing else carries.

**3. `Sync Years` is not "always visible".** The Years column footer sits below
its rows, so a populated column puts it at y≈700. Never assert a column footer
in place — `scrollUntilVisible` + `centerElement`, and let the scroll be the
assertion.

See [[maestro-web-getnodetext]] and [[per-worker-data-isolation]].
