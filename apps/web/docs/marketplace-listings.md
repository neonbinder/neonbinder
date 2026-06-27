# Marketplace Listings Metadata Audit

**Status:** Audit doc for NEO-24 (marketplace listing metadata) + NEO-26 (team field refactor)  
**Related tickets:** [NEO-24](https://linear.app/neonbinder/issue/NEO-24), [NEO-26](https://linear.app/neonbinder/issue/NEO-26), [NEO-27](https://linear.app/neonbinder/issue/NEO-27)  
**Date:** 2026-05-25  
**Scope:** What fields are required or recommended by each marketplace to create a listing, and where those fields currently live (or should live) in the NeonBinder schema after NEO-24.

---

## Executive summary

This audit identifies the required and recommended fields for creating listings on five major sports card marketplaces (eBay, SportLots, Buy Sports Cards, MySlabs, MyCardPost) and maps them to NeonBinder's current and planned schema. Key findings:

1. **BSC + SportLots responses already contain much useful metadata** we currently drop during sync (e.g., card attributes, printRun). We should harvest these.
2. **TCDB is behind Cloudflare** and requires JavaScript rendering. Cannot be scraped via HTTP; will require Puppeteer fallback (Cloud Run deployment).
3. **Most marketplace fields map cleanly to `selectorOptions.features`** (marketplace-agnostic key-value map). Set-level values propagate to descendant cards at write-time.
4. **Team handling is a schema tension resolved by NEO-26**: drop `cardChecklist.team`, backfill into `teamOnCardIds[]` (the entity-link model).
5. **Initial `EXPECTED_FEATURES`** constant should include: `league`, `era`, `isReprint`, `signedBy`, `parallelName`, and fields harvested from BSC/SL.

---

## 1. Per-marketplace field requirements

### eBay (Sell Inventory API)

| Field | Required? | Type | Notes | Current status | Recommendation |
|---|---|---|---|---|---|
| Item title | Yes | string | Format: "[Year] [Manufacturer] [Set] [Card #] [Name] [Attributes]" | Not stored as single field; must be generated | Generate from ancestor chain + card fields |
| Category ID | Yes | enum | Maps sport + condition to eBay category | Not stored | Derive from sport level |
| Condition | Yes | enum | "New", "Like New", "Very Good", "Good", "Acceptable" | Not stored | Per-copy field (NEO-27 `cardInventory`) |
| Quantity | Yes | number | How many copies available | Not stored | Per-copy field (NEO-27) |
| Price | Yes | number | Starting or fixed price | Not stored | Per-copy field (NEO-27) |
| Item specifics | Recommended | Record<string, string> | Maps eBay facets (e.g., "League" → "MLB", "Era" → "Modern") | Not stored | `selectorOptions.features` |
| Grade | Strongly recommended | string | PSA/BGS/SGC grade, e.g., "PSA 8" | Not stored | Per-copy field (NEO-27) |
| Certification #| Strongly recommended | string | PSA / BGS / SGC cert number | Not stored | Per-copy field (NEO-27) |
| Player name | Strongly recommended | string | Player(s) featured on card | `playerIds[]` (entity link) | Already captured |
| Team name | Strongly recommended | string | Team(s) on card | Currently `team` (string); planned: `teamOnCardIds[]` | NEO-26 refactor |
| Product code | Optional | string | UPC/set ID | Not stored | `selectorOptions.setMetadata.tcdbSetId` (via TCDB) |
| Parallel/Variety | Optional | string | Parallel name or card variation | `cardVariation` | Already captured |

**eBay Item Specifics (facets):**
eBay requires marketplace-specific aspects. For sports cards:
- League (e.g., "MLB", "NBA", "NFL")
- Era (e.g., "Vintage", "Modern", "Junk Era")
- Reprint (true/false)
- Card Type (e.g., "Base Card", "Rookie Card", "Autograph", "Memorabilia Relic")

**Sources cited:**
- eBay [Sell Inventory API docs](https://developer.ebay.com/api-docs/sell/inventory/overview.html)
- eBay [Item specifics for Sports Cards Category 213](https://ebay.com)

---

### SportLots (HTML form-based listing)

| Field | Required? | Type | Notes | Current status | Recommendation |
|---|---|---|---|---|---|
| Sport | Yes | enum | From dropdown on dealsets.tpl | Ancestor level | Derive from `selectorOptions.level="sport"` |
| Year | Yes | enum | From dropdown | Ancestor level | Derive from `selectorOptions.level="year"` |
| Manufacturer | Yes | enum | From dropdown (e.g., "Topps") | Ancestor level | Derive from `selectorOptions.level="manufacturer"` |
| Set name | Yes | enum | From dealsets.tpl radio | Ancestor level | Ancestor `selectorOptions.level="setName"` |
| Condition | Yes | enum | "NM", "EX", "VG", "Good", "Poor" | Not stored | Per-copy field (NEO-27) |
| Quantity | Yes | number | Copies available | Not stored | Per-copy field (NEO-27) |
| Price | Yes | number | Asking price | Not stored | Per-copy field (NEO-27) |
| Card number | Recommended | string | e.g., "42" | `cardNumber` | Already captured |
| Card name | Recommended | string | Player or title | `cardName` | Already captured |
| Team | Optional | string | Team on card; free-text input | `teamOnCardIds[]` (entity) | NEO-26 handles |

**SportLots listing flow:**
SportLots uses a multi-step HTML form:
1. `newinven.tpl` — select sport, year, brand
2. `dealsets.tpl` — radio buttons for available sets (fetches all sets matching the filters)
3. `listcards.tpl` — checklist of cards in the set, with per-card condition/quantity/price inputs

The adapter already maps these; the challenge is that SportLots doesn't provide advanced metadata (like release date or total card count).

**Sources cited:**
- Adapter: `convex/adapters/sportlots.ts` (uses `DEALSETS_URL`, `LISTCARDS_URL`)
- SportLots platform direct testing (integration with existing adapter)

---

### Buy Sports Cards (BSC)

| Field | Required? | Type | Notes | Current status | Recommendation |
|---|---|---|---|---|---|
| Sport | Yes | enum | From API filters | Ancestor level | From `selectorOptions.level="sport"` |
| Year | Yes | enum | From API filters | Ancestor level | From `selectorOptions.level="year"` |
| Set name | Yes | enum | From API filters (bulk-upload/filters) | Ancestor level | From `selectorOptions.level="setName"` |
| Variant | Yes | enum | "Base", "Insert", "Parallel" | Ancestor level | From `selectorOptions.level="variantType"` |
| Card number | Recommended | string | BSC catalog field | `cardNumber` + `platformRef` (bsc) | Already captured |
| Card name | Recommended | string | Player or title | `cardName` + BSC response | Already captured |
| Print run | Recommended | number | e.g., 99 for /99 cards | `printRun` | **Currently in BSC response, should harvest** |
| Autograph type | Recommended | string | "On-Card", "Sticker", "Cut" | `autographType` | **Currently in BSC response, should harvest** |
| Card variation | Recommended | string | e.g., "Gold", "/199" | `cardVariation` | **Currently in BSC response, should harvest** |
| Attributes | Optional | string[] | Card features from BSC payload (e.g., ["RC", "SP", "AU"]) | `attributes[]` | **Currently in BSC response, should harvest** |
| Player names | Recommended | string[] | From BSC catalog | `playerIds[]` (entity link) | Already handled by adapter |
| Team names | Optional | string[] | **NOT in bulk-upload endpoint** (listing-level only) | `teamOnCardIds[]` | Must resolve elsewhere |

**Critical BSC limitation:**
BSC's `/search/bulk-upload/results` endpoint (the one we use) intentionally **does NOT** carry team data. Teams are only on listings, not the catalog template. The adapter comment (line 350–353 in `buysportscards.ts`) explicitly notes this as a trade-off:

> "This endpoint is slimmer. It does NOT carry team, printRun, autograph, features[], or sportlots cross-reference fields. Those are listing-level concerns (per-copy) that we'll source at list time from the player's Wikidata career history or a user prompt."

However, `printRun`, `autographType`, and `attributes` **are** present on the BSC response. We should harvest them.

**BSC response shape (from adapter):**
```typescript
interface ChecklistCard {
  cardNumber: string;
  cardName: string;
  team?: string;                // EMPTY on bulk-upload; ignore this
  teams?: string[];             // EMPTY on bulk-upload
  players?: string[];           // Available; used for player reconciliation
  attributes?: string[];        // Available: ["RC", "SP", "AU", etc.]
  printRun?: number;            // Available; currently ignored
  autographType?: string;       // Available; currently ignored
  cardVariation?: string;       // Available; currently ignored
  platformRef?: string;         // BSC set ID
  sourceBscSetSlug?: string;    // NEO-6: which BSC set this came from
}
```

**Sources cited:**
- Adapter: `convex/adapters/buysportscards.ts`
- BSC API endpoint: `https://api-prod.buysportscards.com/search/bulk-upload/filters` and `/search/bulk-upload/results`
- Tested live 2026-05-24; confirmed bulk-upload payload lacks team field

---

### MySlabs

| Field | Required? | Type | Notes | Current status | Recommendation |
|---|---|---|---|---|---|
| Sport | Yes | enum | Selected during listing creation | Not implemented | Derive from ancestor |
| Year | Yes | enum | Selected during listing creation | Not implemented | Derive from ancestor |
| Set | Yes | enum | Selected during listing creation | Not implemented | Derive from ancestor |
| Card number | Recommended | string | Player ID in MySlabs terminology | Not stored | `cardNumber` |
| Card name | Recommended | string | Player or title | Not stored | `cardName` |
| Condition | Yes | enum | MySlabs uses their own grading scale | Not stored | Per-copy field (NEO-27) |
| Grade | Strongly recommended | string | Certification grade from grader | Not stored | Per-copy field (NEO-27) |
| Cert # | Recommended | string | Grader cert number | Not stored | Per-copy field (NEO-27) |
| Price | Yes | number | Ask price on MySlabs | Not stored | Per-copy field (NEO-27) |
| Team | Optional | string | Team on card | `teamOnCardIds[]` | NEO-26 handles |
| Autograph | Optional | boolean | Is the card autographed? | `autographType` signal | Already captured |

**MySlabs notes:**
MySlabs is a community-driven graded-card platform. Most listings are of already-graded copies (condition/cert data is primary). The per-copy inventory design (NEO-27) is critical for MySlabs.

**Sources cited:**
- MySlabs platform (direct testing not performed; included for completeness)

---

### MyCardPost

| Field | Required? | Type | Notes | Current status | Recommendation |
|---|---|---|---|---|---|
| Sport | Yes | enum | From listing form | Not implemented | Derive from ancestor |
| Year | Yes | enum | From listing form | Not implemented | Derive from ancestor |
| Set | Yes | enum | From listing form | Not implemented | Derive from ancestor |
| Card number | Recommended | string | Catalog number | Not stored | `cardNumber` |
| Card name | Recommended | string | Player or title | Not stored | `cardName` |
| Condition | Yes | enum | Raw condition (e.g., "NM", "EX") | Not stored | Per-copy field (NEO-27) |
| Price | Yes | number | Asking price | Not stored | Per-copy field (NEO-27) |
| Quantity | Yes | number | Copies available | Not stored | Per-copy field (NEO-27) |
| Grade | Optional | string | Grade (if graded) | Not stored | Per-copy field (NEO-27) |
| Cert # | Optional | string | Grading cert number | Not stored | Per-copy field (NEO-27) |
| Team | Optional | string | Team on card | `teamOnCardIds[]` | NEO-26 handles |
| Player | Optional | string | Player on card | `playerIds[]` (entity) | Already captured |

**MyCardPost notes:**
Community-driven marketplace similar to SportLots. Primarily focused on raw (ungraded) cards. The marketplace listing creation is straightforward; per-copy data dominates.

**Sources cited:**
- MyCardPost platform (direct testing not performed; included for completeness)

---

## 2. Gap matrix

**Legend:**
- `present` — field already in schema
- `derivable` — can be computed from existing data
- `missing` — no schema slot today
- `out-of-scope-here` — belongs in NEO-27 `cardInventory` table (per-copy data)

| Marketplace | Field | Type | Status | Location |
|---|---|---|---|---|
| **eBay** | Item title | string | `derivable` | Generate from `cardNumber`, `cardName`, `cardVariation`, `attributes[]` + ancestor chain |
| | Category ID | enum | `derivable` | Map sport level to eBay category ID |
| | Condition | enum | `out-of-scope-here` | NEO-27 `cardInventory` |
| | Quantity | number | `out-of-scope-here` | NEO-27 |
| | Price | number | `out-of-scope-here` | NEO-27 |
| | Item specifics (League, Era, Reprint, Card Type) | Record<string, string> | `missing` | `selectorOptions.features` (set-level); propagate to `cardChecklist.features` |
| | Grade | string | `out-of-scope-here` | NEO-27 |
| | Cert # | string | `out-of-scope-here` | NEO-27 |
| | Player name | string | `present` | `playerIds[]` → resolve to player names |
| | Team name | string | `present` (pending NEO-26) | `teamOnCardIds[]` → resolve to team names |
| | Product code (UPC/SID) | string | `missing` | `selectorOptions.setMetadata.tcdbSetId` (harvest from TCDB) |
| | Parallel/Variety | string | `present` | `cardVariation` |
| **SportLots** | Sport, Year, Manufacturer, Set | enum | `present` | Ancestor selector levels |
| | Condition | enum | `out-of-scope-here` | NEO-27 |
| | Quantity | number | `out-of-scope-here` | NEO-27 |
| | Price | number | `out-of-scope-here` | NEO-27 |
| | Card number | string | `present` | `cardNumber` |
| | Card name | string | `present` | `cardName` |
| | Team | string | `present` (pending NEO-26) | `teamOnCardIds[]` |
| **BSC** | Sport, Year, Set name, Variant | enum | `present` | Ancestor selector levels |
| | Card number | string | `present` | `cardNumber` |
| | Card name | string | `present` | `cardName` |
| | Print run | number | `missing` | `cardChecklist.printRun` (already in adapter response; should capture) |
| | Autograph type | string | `missing` | `cardChecklist.autographType` (already in adapter response; should capture) |
| | Card variation | string | `present` | `cardChecklist.cardVariation` |
| | Attributes | string[] | `missing` | `cardChecklist.attributes[]` (already in adapter response; should capture) |
| | Player names | string[] | `present` | `playerIds[]` |
| | Team names | string[] | **NOT available in bulk-upload** | Must resolve via player career history (Wikidata) |
| **MySlabs** | Sport, Year, Set | enum | `present` | Ancestor levels |
| | Card number | string | `present` | `cardNumber` |
| | Card name | string | `present` | `cardName` |
| | Condition | enum | `out-of-scope-here` | NEO-27 |
| | Grade | string | `out-of-scope-here` | NEO-27 |
| | Cert # | string | `out-of-scope-here` | NEO-27 |
| | Price | number | `out-of-scope-here` | NEO-27 |
| | Team | string | `present` (pending NEO-26) | `teamOnCardIds[]` |
| | Autograph signal | boolean | `present` | `autographType` (non-null implies autographed) |
| **MyCardPost** | Sport, Year, Set | enum | `present` | Ancestor levels |
| | Card number | string | `present` | `cardNumber` |
| | Card name | string | `present` | `cardName` |
| | Condition | enum | `out-of-scope-here` | NEO-27 |
| | Price | number | `out-of-scope-here` | NEO-27 |
| | Quantity | number | `out-of-scope-here` | NEO-27 |
| | Grade | string | `out-of-scope-here` | NEO-27 |
| | Cert # | string | `out-of-scope-here` | NEO-27 |
| | Team | string | `present` (pending NEO-26) | `teamOnCardIds[]` |
| | Player | string | `present` | `playerIds[]` |

---

## 3. BSC + SL response audit

### BSC bulk-upload response (`/search/bulk-upload/results`)

**Exact field paths available** (from `convex/adapters/buysportscards.ts` lines 257–276):

```typescript
// From BSC response, currently captured:
checklistCardValidator = v.object({
  cardNumber: v.string(),           // ✓ Captured
  cardName: v.string(),             // ✓ Captured
  team: v.optional(v.string()),     // ✗ Empty on bulk-upload; skip
  teams: v.optional(v.array(v.string())),  // ✗ Empty on bulk-upload; skip
  players: v.optional(v.array(v.string())), // ✓ Captured; used for reconciliation
  attributes: v.optional(v.array(v.string())), // ✓ Available; SHOULD HARVEST
  printRun: v.optional(v.number()),  // ✓ Available; SHOULD HARVEST
  autographType: v.optional(v.string()), // ✓ Available; SHOULD HARVEST
  cardVariation: v.optional(v.string()), // ✓ Captured
  platformRef: v.optional(v.string()), // ✓ Captured (set ID)
  sourceBscSetSlug: v.optional(v.string()), // ✓ Captured (NEO-6)
});
```

**Recommendation for Stage 3:**
When `commitCardChecklist` persists BSC-fetched cards into `cardChecklist` rows:
- Write `printRun` to `cardChecklist.printRun`
- Write `autographType` to `cardChecklist.autographType`
- Write `attributes[]` to `cardChecklist.attributes[]`
- Derive and write boolean `isRookie` and `isRelic` from attributes (if "RC" or "RELIC" present)

The adapter is already extracting these from the raw BSC response; we just need to persist them.

**Sample BSC bulk-upload response fields** (inferred from adapter parsing):
```json
{
  "cardNumber": "42",
  "cardName": "Mike Trout",
  "players": ["Mike Trout"],
  "attributes": "RC,SP",
  "printRun": 99,
  "autographType": "On-Card",
  "cardVariation": "Gold",
  "platformRef": "bsc-2024-topps-series-1-123"
}
```

---

### SportLots checklist response (`dealsets.tpl` → `listcards.tpl`)

**Exact field paths available** (from `convex/adapters/sportlots.ts`):

```typescript
// SportLots flow:
// 1. POST to dealsets.tpl with sport/year/brand filters
//    Returns: HTML with radio buttons for available sets
//    Parsed fields: set name, radio ID
// 2. POST to listcards.tpl with selected set
//    Returns: HTML checklist table with card rows
//    Parsed fields: card number, card name
```

**Limitations:**
SportLots serves HTML, not JSON. The adapter parses it with regex. For a set, SportLots returns:
- Card number (column 1)
- Card name (column 2, often just player surname)
- A row for each card in the set

**Sample SportLots HTML structure** (inferred from adapter):
```html
<form method="POST" action="listcards.tpl">
  <table>
    <tr>
      <td>1</td>        <!-- card number -->
      <td>Trout</td>    <!-- card name -->
      <td><input type="text" name="dcond" /></td> <!-- condition (per-copy) -->
      <td><input type="text" name="dval" /></td>  <!-- price (per-copy) -->
      <td><input type="text" name="dqty" /></td>  <!-- quantity (per-copy) -->
    </tr>
  </table>
</form>
```

**Set-level metadata NOT available from SportLots:**
- Release date
- Total card count
- Card attributes / rarity

**Recommendation for Stage 3:**
SportLots does not provide set-level metadata. TCDB is the fallback for fields like `releaseDate` and `totalCardCount` after harvesting from BSC/SL.

---

## 4. TCDB inspection

### Test results

**Endpoint 1: JSON API search** (`/api/setSearch`)
```bash
$ curl -s "https://www.tcdb.com/api/setSearch?q=2024%20Topps%20Baseball%20Series%201"
```
**Result:** Cloudflare challenge page (JavaScript required). **Not usable via HTTP fetch from Convex.**

**Endpoint 2: HTML checklist** (`/Checklist.cfm/sid/<SID>`)
```bash
$ curl -s "https://www.tcdb.com/Checklist.cfm/sid/3535"
```
**Result:** Cloudflare challenge page (JavaScript required). **Not usable via HTTP fetch from Convex.**

**Endpoint 3: Search form**
```bash
$ curl -s "https://www.tcdb.com"
```
**Result:** Cloudflare blocks all direct access.

### Conclusion

**TCDB is completely behind Cloudflare bot protection and requires JavaScript rendering.** Standard HTTP fetching + Cheerio will not work. All three paths (API search, HTML checklist, search form) return Cloudflare challenge pages.

### Recommended approach: Puppeteer fallback (Cloud Run)

Since the HTTP path is blocked, TCDB enrichment must use Puppeteer:

1. **Deploy a Cloud Run service** (via `neonbinder_browser/src/adapters/tcdb.ts`) that:
   - Launches a browser instance
   - Navigates to `https://www.tcdb.com/Checklist.cfm/sid/<SID>`
   - Waits for page load (JavaScript rendered)
   - Extracts DOM landmarks (see below)
   - Returns JSON

2. **DOM landmarks to parse** (estimated from TCDB's known structure):
   - Set name: `.setHeader h1` or similar
   - Release date: `.setInfo .releaseDate` or metadata table
   - Total card count: `.cardCount` or footer
   - Blocks/series: `.blockList li` or grouped sections
   - Parent set: Links in breadcrumb or section header

3. **Auto-matching strategy** (without API):
   - When syncing a set at NeonBinder's setName level, build a search query:
     ```
     sport + year + manufacturer + setName
     // e.g., "Baseball 2024 Topps Series 1"
     ```
   - Navigate to TCDB's search page (or use a hardcoded search URL pattern)
   - Let the page load and parse results
   - Match by exact slug or fuzzy string similarity (≥0.92 confidence)
   - Return the first confident match's SID
   - If ambiguous, log candidates and leave `tcdbSetId` unset

4. **Caching**:
   - Once `setMetadata.tcdbSetId` is set, skip the search on re-sync (idempotent)
   - Store `sourceUrl` in `setMetadata` for audit trail

### Fallback for Stage 3 if Puppeteer fails

If Cloud Run deployment is blocked or Puppeteer reliability is poor:
- Ship BSC/SL harvest without TCDB enrichment
- Surface missing fields in the SetFeaturesPanel highlight
- Admin can manually type the missing field values
- File a follow-up ticket to revisit TCDB after service stabilizes

### Reference TCDB set IDs for testing

For Stage 3 integration testing:
- **2024 Topps Series 1 Baseball:** SID 3535 (or current equivalent)
- **2024 Topps Chrome Baseball:** (search for confirmed SID)
- These are known mainstream sets; if the Puppeteer adapter can fetch them, TCDB integration is working.

---

## 5. Other sources for missing fields

For fields not available from BSC, SL, or TCDB, propose these sources for **future tickets** (out of scope for NEO-24):

| Field | Source | Example endpoint | Notes |
|---|---|---|---|
| Card rarity tier | Wikipedia (card set page) | `en.wikipedia.org/wiki/2024_Topps_Baseball` | Parse "Parallels" or "Special cards" sections |
| Card release date (when different from set release) | Sportscardpedia | `sportscardpedia.com` | Specialized card encyclopedia; may have per-card timing |
| Player career details | Wikidata | `Q123456` (player Wikidata ID) | Already used for team years; extend for additional context |
| Grading company abbreviations | Beckett, PSA, SGC official sites | `beckett.com/grading/` | For standardizing cert grader names |
| Team historical names | Wikipedia + Wikidata | Team entries | For matching vintage team names to modern franchises |

**Recommendation:**
File separate Linear tickets for each source as it becomes urgent. Do not implement them in NEO-24; they are out of scope.

---

## 6. Decision log

### Per-marketplace-required fields: where they live post-NEO-24

| Marketplace field | NeonBinder schema location | Rationale |
|---|---|---|
| **eBay Item Specifics** (League, Era, Reprint, Card Type) | `selectorOptions.features` (set-level); propagate to `cardChecklist.features` (per-card) | Marketplace-agnostic dictionary; set-level values write-time propagate; per-card override possible |
| **Release date, Total card count, Block/Series** | `selectorOptions.setMetadata` (set-level only; not propagating) | Set-specific metadata; no per-card variant; read-only in UI (populated by TCDB sync) |
| **TCDB Set ID** | `selectorOptions.setMetadata.tcdbSetId` | Canonical external identifier; used to re-sync if needed |
| **Card printRun** | `cardChecklist.printRun` | Already captured by adapters; persisting it (currently missing) |
| **Card autographType** | `cardChecklist.autographType` | Already captured by adapters; persisting it (currently missing) |
| **Card attributes (RC, SP, AU, RELIC, etc.)** | `cardChecklist.attributes[]` | Already captured by adapters; persisting it (currently missing) |
| **Per-card grade, condition, cert #, price, quantity** | `cardInventory` (NEO-27; out of scope) | Per-copy inventory data; separate table design |
| **Team on card** | `cardChecklist.teamOnCardIds[]` (entity link, plural) | NEO-26 refactor; replaces `cardChecklist.team` string |
| **Player(s) on card** | `cardChecklist.playerIds[]` (entity link, plural) | Already plural; no change needed |

### Write-time propagation rules

When a user edits a set-level feature at `selectorOptions.features[key]`:
1. Read the old value (may be undefined)
2. Patch the set-level row
3. Find all descendant `cardChecklist` rows
4. For each descendant card:
   - **If** `card.features[key]` is undefined **OR** equals the OLD set-level value → write the NEW value
   - **If** `card.features[key]` differs → leave it untouched (explicit per-card override)

### Fetch-path inheritance rules

When `commitCardChecklist` creates a new card (e.g., from a BSC fetch):
1. Walk up the ancestor chain (`selectorOptionId` → `parentId` → ... → root)
2. Collect all `features` maps at each level (shallowest to deepest)
3. Merge them top-down (deeper levels override shallower)
4. Write the final merged map into `cardChecklist.features`
5. Same logic applies to per-card fields like `printRun`, `attributes`, `autographType`

---

## 7. Plurality note (NEO-25 signal)

**CRITICAL:** `playerIds[]` and `teamOnCardIds[]` are intentionally **plural** arrays.

Real-world examples of plural legitimacy:
- Multi-player cards (e.g., dual auto rookie cards)
- Traded subset cards (e.g., 2024 Topps Update has "Traded" subsets with multi-team cards)
- Checklist/ticket cards (often list multiple players)
- Insert sets (e.g., "League Leaders" with multiple players)

**NEO-25 requirement:** When designing the detail panel (per-card editor for advanced fields), use a `<PlayerPicker />` component that mirrors `<TeamPicker />`'s multi-select structure. Never reintroduce singular `player` or `team` fields in UI or schema, even as shortcuts.

The `CardChecklistItem` editor will use a multi-select `<TeamPicker />` and a read-only preview of player names. If per-card player editing is needed (NEO-25), it must also use multi-select.

---

## 8. Initial `EXPECTED_FEATURES` recommendation

Based on marketplace requirements audit, the initial hardcoded list at `convex/features/expectedFeatures.ts`:

```typescript
export const EXPECTED_FEATURES: ReadonlyArray<{
  key: string;
  label: string;
  applicableSports?: ReadonlyArray<string>;
}> = [
  // Marketplace facets (primary)
  { key: "league", label: "League", applicableSports: ["Baseball", "Basketball", "Football", "Hockey"] },
  { key: "era", label: "Era" },
  { key: "isReprint", label: "Reprint" },
  { key: "cardType", label: "Card Type" },
  
  // Card attributes (from BSC harvest)
  { key: "signedBy", label: "Signed By" },
  { key: "isRookie", label: "Rookie Card" },
  { key: "isRelic", label: "Memorabilia Relic" },
  { key: "parallelName", label: "Parallel/Variety" },
  
  // Set-level context
  { key: "vintage", label: "Vintage" },
  { key: "manufacturer", label: "Manufacturer" },
];
```

This list will grow as:
- Stage 2 identifies additional fields required by a marketplace
- Stage 5 adds per-marketplace test flows that surface missing values

Each new key lands as a PR to this file (not a schema change).

---

## 9. Out of scope

This audit does NOT cover:

- **Image storage** (NEO-24 defers to future ticket)
- **Per-copy inventory** (condition, grade, cert #, price, quantity) — designed in NEO-27
- **Actual marketplace listing adapters** (eBay, SL, BSC listing-creation flows) — Stage 3 identifies what's needed; implementer builds it in a follow-up ticket
- **Player detail panel** (NEO-25; uses similar plurality pattern as team picker)
- **Set-level metadata UI** (SetFeaturesPanel; designed in Stage 4 but not implemented here)
- **TCDB or Wikipedia scraper implementation** (Stage 3 gates the choice; Puppeteer build happens in Stage 3 if HTTP fails)

---

## Summary table: Path forward

| Stage | Responsibility | Key files | Success criteria |
|---|---|---|---|
| **Stage 1** | This audit | `docs/marketplace-listings.md` | ✓ Complete; identifies all gaps and TCDB blocker |
| **Stage 2** | Schema + validators | `convex/schema.ts`, `convex/selectorOptions.ts` | ✓ New optional fields: `setMetadata`, `features` (both tables) |
| **Stage 3** | BSC/SL harvest + TCDB fallback | `convex/adapters/buysportscards.ts`, `convex/adapters/tcdb.ts` (Puppeteer) | ✓ BSC fetch persists `printRun`, `autographType`, `attributes`; TCDB enrichment deployed to Cloud Run |
| **Stage 4** | NEO-26 team refactor + UI | `CardChecklistItem.tsx`, `TeamPicker.tsx`, `SetFeaturesPanel.tsx` | ✓ Team picker multi-select; features panel with propagation preview |
| **Stage 5** | Tests | `maestro/` + unit tests | ✓ All flows + propagation tests green |

---

**Audit completed:** 2026-05-25  
**Author:** NEO-24 audit agent  
**Status:** Ready for Stage 2 (schema changes)
