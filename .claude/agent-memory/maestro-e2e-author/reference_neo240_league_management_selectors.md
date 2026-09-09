---
name: neo240-league-management-selectors
description: "/admin/leagues (NEO-240) selectors and traps: the counter gate, the single-<select> sport picker, the `Create league <name>` aria-label, the page-level vs panel-level status lines, level as aria-pressed buttons (UNREADABLE — assert the master row's level segment instead), aliases as chips; plus the reusable `title={name}` → `id:` trick for tapping a master row whose text collides with the filter box"
metadata:
  type: reference
---

# `/admin/leagues` — League Management (NEO-240)

Third entity editor, same master-detail shape as `/admin/players` and
`/admin/teams`, so the Players-screen idioms transfer wholesale. Flow:
`.maestro/flows/admin/league-management-add-and-edit.yaml`.

## Gates and handles

| What | Selector |
|---|---|
| Loaded gate | `.*of .* leagues.*` (`<p role="status">` `{n} of {N} leagues[ · {k} need attention][ · list truncated]`) — the h2 paints while the query is still in flight |
| Empty list | `No leagues match that filter.` |
| Unselected detail | `Select a league to see its teams and edit what we know about it.` |
| Filter box | `tapOn: "Filter leagues"` (label span) |
| Sport picker | `tapOn: "All sports"` → `tapOn: "<Sport>"` → `assertVisible: "<Sport>"` |
| Add | `tapOn: "Add league"` → h3 `Add a league` |
| Add fields | `New league name`, `Abbreviation`, `<select id=new-league-sport>` (defaults to the LIST filter's sport) |
| Create | `id: "Create league {trimmed name}"` (aria-label); text is just `Create league` |
| Insert confirmation | `.*Added {name}.*` — **page-level**, top of the screen |
| Detail fields | `League name`, read-only `Sport: {label}`, `Abbreviation`, `Wikidata id`, `Active from`, `Active to`, `Aliases` |
| Alias chips | `<ul aria-label="Current aliases">`, one `<li>` per parsed alias |
| Roster | h3 `Teams in this league`, empty `No teams yet.`, link `Manage in Team Management` |
| Save confirmation | `.*Saved {name}.*` — **panel-level, directly BELOW the action row** |

## Traps

**1. Two status lines, in two different places.** The ADD form's messages go to
the page-level `<p role=status>` above the filter row; the DETAIL panel's go to
its own line under the Save/Re-enrich row. So `Added …` needs a scroll back UP
after the Create tap (the Create button was centred near the fold), while
`Saved …` is a plain wait — it renders where you already are. Do **not**
`centerElement` the `Added …` scroll: that line sits less than half a viewport
below the top of the document, so no scroll position centres it.

**2. Level is a `role="group" aria-label="Level"` of six `aria-pressed`
buttons — and maestro-web cannot read `aria-pressed`.** `resource-id` is
`id || ariaLabel || name || title || htmlFor || data-testid`; pressed state is
not in it. Assert the level via the MASTER ROW's own level segment instead
(`Minor` etc.), and do it while the detail panel is on its placeholder — with
the panel closed there is no Level group on the page, so the row is the only
thing that can say it. (Same shape as the ToggleOptions note.)

**3. Pick the sport BEFORE opening the add form.** Closed, `#sport-filter` is
the only `<select>` on the page; open, the form adds `#new-league-sport` and the
first-`<select>`-only limitation makes the form's picker undrivable. The form
pre-selects the list filter's sport, so setting it on the list is both safe and
sufficient. Identical to the Players screen.

**4. Aliases: type TWO, comma-separated.** The Aliases input's Maestro text is
the WHOLE comma string, each chip is one alias, and matching is fully anchored —
so a single-alias assertion cannot be answered by the box, only by a chip. One
alias would make the box and the chip read identically and the assertion
vacuous. Two also proves the split, which is the actual feature.

**5. `createByAdmin` schedules a Wikidata enrichment on INSERT** (via
`wikidataPool`), same as `teams.findOrCreate`. Harmless for a nonsense
per-attempt name — Wikidata answers nothing — but never tap
`Re-enrich from Wikidata`, which is a live outbound SPARQL call from CI.

**6. Backend limits worth knowing before naming things:** abbreviation ≤ 16
chars (so `L${ATTEMPT_ID}` fits: the longest runner id is `r7-a3-32767`, 11
chars), name ≤ 120, ≤ 32 aliases of ≤ 64 chars, years ≥ 1850. Aliases collide
across the SPORT: a rename or alias onto a key a sibling row answers to throws
`NAME_TAKEN:<id>` — so per-attempt alias names, not shared ones.

## REUSABLE: tap a master row by `title`, not by an anchored `text`

Every admin master row prints its name in
`<span className="w-full truncate" title={league.name}>{league.name}</span>`.
maestro-web derives `resource-id` from `node.title`, so **`id: "<the name>"`
resolves to the row and only the row** — while `text: "<the name>"` also matches
the filter input, which is holding that exact string after you filter by it.
The `Input` primitive emits no `id`/`aria-label` when the caller passes no
`id` (it wraps the input in a `<label>` instead), so the input has NO
resource-id and cannot answer an `id:` selector.

This is cleaner than the `below: {counter}` anchoring the Players flow uses, and
it is not leagues-specific — `/admin/teams` and `/admin/players` rows carry the
same `title`.

Corollary from the same primitive: with no caller `id`, a field is
`<label><span>{label}</span><input/></label>`, so `tapOn: "<label text>"` hits
the span and the label's activation behaviour focuses the input. That is why
`tapOn: "Active from"` / `"Aliases"` / `"Filter leagues"` work even after the
input holds a value (the input's own text becomes its VALUE, so it stops
answering to the label).

## Cross-screen

`/admin/teams`'s `#league-filter` lists `abbreviation ?? name` for **every**
league (`leagues.list`, no team requirement), so a league with no teams is still
offered. Options only enter the hierarchy while their `<select>` is
`:focus-within`, so `tapOn: "All leagues"` first — that tap is load-bearing, not
navigation. Reading an option needs no tap on the option itself, so the
first-`<select>`-only limitation does not apply to an assertion.

See [[maestro-web-getnodetext]], [[maestro-web-driver-primitives]],
[[neo214-no-seeded-fixture]], [[toggleoptions-pills-maestro]].
