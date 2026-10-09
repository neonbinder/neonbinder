---
name: sportlots-twin-names-and-public-search
description: NEO-325 — a marketplace name shared by two ids gets ` (#<id>)` (both sides) in Reconcile/Base-picker/Attach text AND aria-label, only when repeated; shared Ready titles carry their mapped ids; how to measure twins read-only from public listings (in-stock only); the column twin notice's `#id` lines and the full-match card-row pattern that ignores them; curly-quote clash sentences (match with `.`) and the per-field `Same name as another set.` line
metadata:
  type: reference
---

**What the UI does (NEO-325).** Reconcile (`ReconciliationModal`) and the
Base picker (`BaseSetPicker`) key every candidate by `platformValue`. A name
that more than one DISTINCT id carries on the same side (computed over the
WHOLE side — Pending plus every Ready chip — never the filtered view) shows
its id, the same `(#<id>)` form on both sides: `Make its own set: <name>
(#<id>)`, chip `Remove <name> (#<id>) from <set>`, `SportLots base candidate:
<name> (#<id>)`, Attach sets `Toggle <name> (#<id>)`. Unique names are
unchanged, so existing `…: <name>$` selectors keep matching. `id:` is a full
match: escape the parentheses (`\\(#123\\)`). `Make its own set` on a twin
creates a Ready set TITLED with the bare name; two Ready rows sharing a title
name every row control by the ids they map (`sharedTitleLabels`): `Remove
<name> (#A) from <name> (#A)`, `NeonBinder set name for <name> (#A)`,
`, N of M` if ids are identical too. One-side ids stay bare `(#A, #B)`; a row
holding BOTH sides names them: `<title> (BSC #x · SportLots #y)`. Attach sets computes its dups over
the pane's list AFTER attached ids are dropped, so the remaining twin reads
the BARE name there. The visible suffix is its own span, so a twin's Pending
row is tappable by `text: "\\(#<id>\\)"` (the click bubbles to the handle).

Reconcile's Ready-row attach button reads `Add <item> to this set, <set>`
(changed from `Add <item> to <set>` in the same ticket).

**The Attach sets dialog's SportLots pane drops ids already attached to the
row** (it lists `id: <n>` per candidate), so "this row holds id X" is
perceivable as `id: X` ABSENT from a search that still lists its sibling.
The BSC set list keeps attached rows instead: an `aria-hidden` `attached`
marker plus an sr-only TEXT span `<label> is already attached` (it was an
`aria-label`, i.e. an `id:`, before the NEO-325 a11y pass; no flow used it).

**Measuring a twin fixture read-only.** The dealer set list needs a
SportLots login; public buyer-facing listings on both marketplaces do not,
and are enough to spot same-name pairs (group by set name, >1 id = twin).
They list only sets WITH STOCK, so a stockless twin is invisible. SportLots
usually disambiguates repeats with a code suffix, so true twins are rare:
check every scope the seed provisions before asking for a new real set. The
coordinator holds the exact endpoints in private operational notes; ask for
them rather than rediscovering. Sleep between requests.

**Twin hunting results (2026-10-08):** 2024 Topps Baseball has three pairs
(Chrome Update Sapphire; City Connect Swatch Collection = Series One `CC-` vs
Series Two `CC2-`, BSC splits them as `… Relics (Series One/Two)` under the
flagship setName `Topps`; and its Black). 2023 Topps and Bowman 2022–2026
have NONE: SportLots prefixes each product's sets with its product word and
files Bowman's chrome prospects (BCP-1…150) and Bowman Chrome's (BCP-151+) in
ONE set — the 1996 Score shape (one SL set, two NB parents), not a twin.

**Where else twins surface (NEO-325, later commits).** A column sync that
LEFT twins writes a `done` notice (`SyncDoneNotice`): `Seeing double: …
lists N names more than once, so the sync didn't attach them.`, then one
`<li>` per name, `<name> (SportLots #a, #b)` / `(BSC #x · SportLots #y)`, and
a `Show all N` button that now sits BEFORE the revealed lines. A `.*#[0-9].*` "card row" check matches those
lines, so prove a card row by a FULL match on its number cell,
`text: "#[0-9][^ ]*"` (CardChecklistItem renders `#<n>` alone in a span).
A ONE-sided insert-level store (VariantForm) whose items hit `twinIds` opens
Reconcile instead (amber header line, SportLots prefix filter OFF). The
`parallel` level is never fetched (no marketplace serves it), so ParallelForm
never takes that path. Measured 2026-10-08, BSC public shop facets: no
same-label variantName twins in 2024 Topps Chrome Insert/Parallel, 2024
Topps Insert, 2026 Bowman Insert/Parallel, 1996 Score Insert, and no setName
twins in Baseball 2024/2026/1996/1990 or Hockey 1997/1995/2024; SportLots
public search: 1996 Score has none (17 stocked sets). Both sources list only
in-stock items, so a twin without stock is invisible to them.

**Owner rules (Jason, 2026-10-08).** A marketplace twin is never auto-linked
or auto-created: it waits in Reconcile's Pending (column sync makes no row for
it), so "both twins show `Make its own set: … (#id)`" IS the not-linked proof.
Two Ready sets with one title block Save: "Two sets are both named
“<title>”. Rename one so you can tell them apart." — CURLY quotes since the
NEO-325 copy pass; match each with `.` (one UTF-16 unit, verified with
kotlin Regex). Every clash form (two / "N sets are all named" / "There's
already a set named “X” under <Set › Type>") ends `so you can tell them
apart.`, so that tail is the negative. Each clashing field also shows `Same
name as another set. Tip: add the release, like “Series 1” or “Update”.` —
never write a selector on "Same name" or "Update" text near a clash. The City
Connect pair is the approved sole-writer fixture (2024 Topps › flagship
`Topps` › Insert).

**Renaming a Ready title in a flow:** tap `NeonBinder set name for <label>`
(centre click lands past a short title, so the caret is at the end), type to
APPEND, then blur by tapping the dialog's `Reconcile <Level>` heading (blur
still commits). Not Enter: the Ready title inputs are identically-classed
siblings, so pressKey's XPath re-find hits the FIRST one. Since NEO-325 Enter
commits IN PLACE and keeps focus (Escape reverts in place) — same for the
SportLots review's `Name for <row>` fields. Read the commit back from the OTHER row's
chip dropping its `(#id)` row label.

**Holding a drafted flow:** `wip` keeps it out of CI's queue and the local
full-suite/grep selections, but the local TAG mode (`test:e2e:pick --
set-selector`) still includes wip flows despite the script's own comment.

Related: [[measure-a-fixture-from-ci-artifacts]] (adapter `result_count` per
scope from convex logs), [[touch-swipe-scrolls-a-dialog-body]],
[[inner-scroller-clip-is-invisible-to-maestro]].

**Dealer-list twins the public search missed (live dialog, 2026-10-08).**
2024 Topps' dealer list also has "Chrome Black Refractor" twice (305604 /
309103, one side stockless), and in the City Connect family the twinned
variant is `… Gold` (307439 / 299609), NOT `… Black` (one `… Black` plus a
`… Black /199`). Consequence: since the exactly-one guard, the seed's 2024
Topps Chrome `Parallel` reconcile saves 41, not 42 (BSC `Black Refractors`
stays Pending) — a fixture count pinned before a matcher change is a
suspect, not a regression, until the delta is named. Prove which pair
dropped with [[probe-a-fixture-without-draining-it]] (matcher diff recipe).
