---
name: Search input selection for EntitySelector (use below:, not index)
description: After typing in an EntitySelector search box, select the result ROW by relationship (below: the search input) — index is unreliable across cold-sync vs re-drill
type: feedback
---

After typing a search term (e.g. "2024" / "Topps") into an EntitySelector search
box, TWO elements match that text: the value inside the search `<input>` and the
result row below it. Tapping the input does nothing → the column never advances.

**`index: 1` is NOT reliable.** The DOM order of (input, row) is NOT stable: it
differs between a COLD sync (fresh, just after a reset) and a RE-DRILL of
already-synced data (and when the value is the previously-selected one). NEO-46
proved this: `tapOn: { text: "2024", index: 1 }` selected the row on a cold sync
but landed on the SEARCH INPUT on a re-drill (resource-id `Search years`), so the
year was never selected and the Manufacturers column never opened — a silent
failure that broke the Insert/Parallel pre-sync.

**Correct pattern — select by RELATIONSHIP (position-independent):**
```yaml
- tapOn:
    text: ".*Search years.*"
- inputText: "2024"
- tapOn:
    text: "2024"
    below:
      id: "Search years"      # the result ROW is below the search input
```
The search input's `resource-id` is its aria-label without the ellipsis:
`Search sports` / `Search years` / `Search manufacturers` / `Search sets`
(the visible placeholder text is `Search years…`, but the id is `Search years`).
`below: { id: "Search <entity>" }` matches only the row, never the input itself.

**How to apply:** Any search-then-tap in EntitySelector (sports / years /
manufacturers / sets / inserts / parallels) — select the result with
`below: { id: "Search <entity>" }`. Do NOT use `index:` and do NOT bare-`tapOn`
the typed text. Fixed in `util-drill-to-2024-topps-chrome.yaml` (all four levels).
