---
name: sportlots-twin-names-and-public-search
description: NEO-325 — a marketplace name shared by two ids gets ` (#<id>)` (both sides) in Reconcile/Base-picker/Attach text AND accessible name, only when repeated; twin notices; how to measure twins read-only from public listings; curly-quote clash sentences; the exactly-one guard and its fixture counts
metadata:
  type: reference
---

**What the UI does (NEO-325).** Reconcile (`ReconciliationModal`) and the Base
picker (`BaseSetPicker`) key every candidate by `platformValue`. A name that more
than one DISTINCT id carries on the same side (computed over the WHOLE side, Pending
plus every Ready chip, never the filtered view) shows its id, the same `(#<id>)`
form on both sides: `Make its own set: <name> (#<id>)`, chip `Remove <name> (#<id>)
from <set>`, `SportLots base candidate: <name> (#<id>)`, Attach sets `Toggle <name>
(#<id>)`. Unique names are unchanged, so `name: /...: <name>$/` locators keep
matching. Escape the parentheses in a regex (`\(#123\)`). `Make its own set` on a
twin creates a Ready set TITLED with the bare name; two Ready rows sharing a title
name every row control by the ids they map (`sharedTitleLabels`): `Remove <name>
(#A) from <name> (#A)`, `NeonBinder set name for <name> (#A)`, `, N of M` if ids are
identical too. A row holding BOTH sides names them: `<title> (BSC #x · SportLots
#y)`. Attach sets computes its dups over the pane's list AFTER attached ids are
dropped, so the remaining twin reads the BARE name there. Reconcile's Ready-row
attach button reads `Add <item> to this set, <set>`.

**The Attach sets dialog's SportLots pane drops ids already attached to the row**,
so "this row holds id X" is perceivable as X ABSENT from a search that still lists
its sibling. The BSC set list keeps attached rows instead: an sr-only text span
`<label> is already attached`.

**Measuring a twin fixture read-only.** The dealer set list needs a SportLots login;
public buyer-facing listings on both marketplaces do not, and are enough to spot
same-name pairs (group by set name, more than one id = twin). They list only sets
WITH STOCK, so a stockless twin is invisible. SportLots usually disambiguates
repeats with a code suffix, so true twins are rare: check every scope the seed
provisions before asking for a new real set. The coordinator holds the exact
endpoints in private operational notes; ask for them. Sleep between requests.

**Twin hunting results (2026-10-08):** 2024 Topps Baseball has three pairs (Chrome
Update Sapphire; City Connect Swatch Collection = Series One vs Series Two, BSC
splits them under the flagship setName `Topps`; and its Black). 2023 Topps and
Bowman 2022-2026 have NONE (the 1996 Score shape: one SL set, two NB parents, not a
twin). Dealer-list twins the public search missed: 2024 Topps' list also has
"Chrome Black Refractor" twice, and in the City Connect family the twinned variant
is `... Gold`, not `... Black`. Since the exactly-one guard, the seed's 2024 Topps
Chrome `Parallel` reconcile saves 41, not 42: a fixture count pinned before a
matcher change is a suspect, not a regression, until the delta is named.

**Where else twins surface.** A column sync that LEFT twins writes a `done` notice
(`SyncDoneNotice`): `Seeing double: ... lists N names more than once, so the sync
didn't attach them.`, one line per name, and a `Show all N` button that sits BEFORE
the revealed lines. A loose `#[0-9]` text check matches those lines, so prove a card
row by an exact match on its number cell (CardChecklistItem renders `#<n>` alone in a
span). A ONE-sided insert-level store (VariantForm) whose items hit `twinIds` opens
Reconcile instead. The `parallel` level is never fetched (no marketplace serves it).
Measured 2026-10-08 on public facets: no same-label variantName twins in 2024 Topps
Chrome Insert/Parallel, 2024 Topps Insert, 2026 Bowman Insert/Parallel, 1996 Score
Insert, and no setName twins in Baseball 2024/2026/1996/1990 or Hockey
1997/1995/2024.

**Owner rules (Jason, 2026-10-08).** A marketplace twin is never auto-linked or
auto-created: it waits in Reconcile's Pending (column sync makes no row for it), so
"both twins show `Make its own set: ... (#id)`" IS the not-linked proof. Two Ready
sets with one title block Save: "Two sets are both named “<title>”. Rename one so
you can tell them apart." with CURLY quotes: match each quote with `.` in a regex.
Every clash form ends `so you can tell them apart.`, so that tail is the negative.
Each clashing field also shows `Same name as another set. Tip: add the release, ...`.
The City Connect pair is the approved sole-writer fixture (2024 Topps, flagship
`Topps`, Insert).

**Renaming a Ready title in a spec:** `click` `NeonBinder set name for <label>` (a
centre click lands past a short title, so the caret is at the end), `pressSequentially`
to APPEND (not `fill`, which replaces), then blur by clicking the dialog's
`Reconcile <Level>` heading (blur still commits). Enter commits IN PLACE and keeps
focus (Escape reverts in place), same for the SportLots review's `Name for <row>`
fields; the Ready title inputs have distinct accessible names, so address each by its
`NeonBinder set name for <label>`. Read the commit back from the OTHER row's chip
dropping its `(#id)`.

Related: [[measure-a-fixture-from-ci-artifacts]].
