---
name: Set Sync Feature Review
description: Code review findings from set syncing feature (BSC + SportLots → selectorOptions hierarchy)
type: project
---

Set sync feature reviewed via code inspection on 2026-03-15. Both dev servers were running (ports 3000 and 8080) but no browser automation tool was available for live UI testing.

**Architecture summary:** `fetchAggregatedOptions` action in `selectorOptions.ts` orchestrates calls to both `adapters/buysportscards.ts` (REST API) and `adapters/sportlots.ts` (HTTP scraping). Results are merged by normalized value and stored via `storeSelectorOptions` mutation. Hierarchy is sport → year → manufacturer → setName → variantType, each level parented to the previous via `selectorOptions.parentId`.

**Known bugs found in code review:**

1. Error and success feedback use identical blue box styling in all five sync forms — no visual differentiation for failures.

2. BSC sport filter is lowercased but other level filters are not — inconsistency could cause silent failures at year/manufacturer level if BSC API is case-sensitive.

3. SportLots card checklist parser (`fetchSportLotsChecklist`) uses a regex targeting `<tr><td>card#</td><td>name</td>` rows, but `newinven.tpl` is an inventory entry form — not a card listing page. The regex almost certainly returns zero cards. The correct URL for a card checklist on SportLots is different from the newinven page.

4. `addCustomSelectorOption` silently returns existing ID on duplicate — no user feedback that the entry already existed.

5. After a custom entry gets merged with a marketplace entry during sync, the `isCustom` flag is never cleared — entry keeps showing "Custom" badge even after acquiring real platform data.

**Needs hands-on verification:**
- BSC API response shape: does it use `facets` or `aggregations` key?
- SportLots `newinven.tpl` cascade behavior: does posting sport return years in the same response, or does it require separate cascaded requests?
- Live credential check: BSC requires Puppeteer login to extract bearer token; SL uses direct HTTP with username/password.

**How to apply:** When testing or reviewing further set sync work, focus on the card checklist URL bug (Bug 3) — it is a functional break, not just UX. Also watch for the error/success styling issue when reporting test results.
