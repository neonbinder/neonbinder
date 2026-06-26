---
name: Set selector UI text and layout patterns
description: Exact visible text, button labels, headings, and empty states for the /set-selector page and its components
type: reference
---

## Set Selector page heading
- Page title: "Set Selector" (appears twice — once in the page `<h1>` and once inside the SetSelector component)

## Hierarchy — 6 levels (plus optional level 7)
Level 1: Sports
Level 2: Years
Level 3: Manufacturers
Level 4: Sets
Level 5: Variant Types  (formerly "Set Variants" — renamed)
Level 6: Variants       (new — was combined with level 5 before)
Level 7: Sub-Variants   (optional, only shown after a Variant is selected)
Cards panel: full-width below the selector row (not a column), visible after selecting a Variant

## Column titles (EntitySelector title prop)
- Sports, Years, Manufacturers, Sets, Variant Types, [variantType pluralized], Sub-Variants
- Level 6 column header is the PLURALIZED variantType value (PR #32):
  - variantType="Insert" → column header "Inserts"
  - variantType="Parallel" → column header "Parallels"
  - variantType="Base" → column is SUPPRESSED (Base is terminal, no Level 6)
  - Any other variantType ending in "s" → left as-is; otherwise append "s"
  - Fallback (while variantType still loading) → "Variants"
- NEVER assert literal "Variants" as a column heading — it only appears in the fallback state

## Sync button text per column (EntityColumn addButtonText prop)
- "Sync Sports", "Sync Years", "Sync Manufacturers", "Sync Sets",
  "Sync Variant Types", "Sync [variantColumnLabel]", "Sync Sub-Variants"
- variantColumnLabel = pluralized variantType (same rule as column heading above)
  - Insert → "Sync Inserts"
  - Parallel → "Sync Parallels"

## Add custom button aria-label per column
- aria-label = `Add custom ${addButtonText.replace(/^Sync /, "")}`
- Level 6 Insert: aria-label = "Add custom Inserts" → use `id: "Add custom Inserts"` in Maestro
- Level 6 Parallel: aria-label = "Add custom Parallels" → use `id: "Add custom Parallels"` in Maestro
- NEVER use `id: "Add custom Variants"` — that no longer matches any element

## CRITICAL: Sync form auto-fire pattern (changed from old "Sync from Marketplaces" button)
All sync forms auto-fire immediately when opened — there is NO "Sync from Marketplaces" button.

Correct pattern:
```yaml
- tapOn: "Sync Sports"
- extendedWaitUntil:
    visible: "Syncing Sport Options"
    timeout: 5000
- extendedWaitUntil:
    visible: "Sync Sports"   # returns when form auto-closes on success
    timeout: 45000
```

On ERROR the form stays open and shows "Retry" + "Cancel" buttons (not "Close").
On SUCCESS the form auto-closes (calls onDone()) and the idle button returns.

## Sync form headings (shown during the auto-fire)
- SportForm: "Syncing Sport Options"
- YearForm: "Syncing Year Options"
- ManufacturerForm: "Syncing Manufacturer Options"
- SetForm: "Syncing Sets"
- SetVariantForm (level 5): "Syncing Variant Types"
- VariantForm (level 6): "Syncing [pluralizedType]" — e.g. "Syncing Inserts", "Syncing Parallels"
  (fallback "Syncing Variants" while ancestor chain resolves; "Select Base Set" for Base variantType)
- ReconciliationModal heading (level 6): "Reconcile [pluralizedType]" — e.g. "Reconcile Inserts", "Reconcile Parallels"
  NEVER assert literal "Reconcile Variants" (PR #32 regression root cause)

## Sync form buttons after completion
- Success: "Close" button (tapping closes the form)
- Error: "Retry" + "Cancel" buttons

## VariantForm special cases (level 6 — "Sync Variants")
- For "Base" variant type: shows BaseSetPicker modal ("Select Base Set" heading)
- For Insert/Parallel with data on BOTH platforms: shows ReconciliationModal ("Reconcile Variants" heading)
- For single-platform data: auto-stores and closes (same as other levels)

## BaseSetPicker modal
- Heading: "Select Base Set" (same as VariantForm heading for Base type — not unique enough to assert modal is open)
- Subtext: "Choose the base set for **[setName]** on each platform. The rest will be discarded."
  Use regex `".*Choose the base set for.*"` to confirm the modal is open.
- Search input (only if >8 SL options): placeholder "Search SportLots sets..."
- "SPORTLOTS BASE" label (uppercase purple, via CSS): text in DOM is "SportLots base" — use `".*SportLots base.*"` or `"SportLots base"` (check visibility, CSS uppercases it)
- "BSC base" section: ONLY shown when BSC has variantName options. For Base variant type, BSC's variantName facet is often empty — the BSC section will NOT appear. Do not assert "BSC base".
- "likely match" badge (green text): shown on SL option with score >= 795; also shown on BSC options with score >= 795 in the BSC section (if visible)
- Auto-selected SL option: highlighted in green. "Chrome" is auto-selected for Topps Chrome.
- Confirm button: "Confirm Base Set"
- Cancel button: "Cancel"

## ReconciliationModal
- Heading: "Reconcile Variants" (level="insert") or "Reconcile Variants of Variants" (level="parallel")
- Subtext: "[N] matched, [N] BSC-only, [N] SL-only ([N] total)"
  e.g., "25 matched, 22 BSC-only, 2504 SL-only (2551 total)"
- Matched section (collapsible): "Matched (N) — click to review"
- Unmatched section header: "Unmatched — drag to link, or drag down to "keep as platform-only""
  Use regex `".*Unmatched.*drag to link.*"` for robustness
- BSC column label: "BSC (N)" — assert with `".*BSC.*"` (uppercase in DOM)
- SL column label: "SportLots (N of M)" — assert with `".*SportLots.*"` (mixed case "SportLots", NOT all-caps; confirmed from DOM hierarchy in PR #24 run)
- SL filter input: placeholder = `Starts with "[setName]"` or `Starts with "[setName]" or "[stripped]"`
  For 2024 Topps Chrome: `Starts with "topps chrome" or "chrome"`
  Use regex `'.*Starts with ".*[Tt]opps [Cc]hrome.*".*'`
- SAVE/confirm button: "Save N matched" (NOT "Confirm N Items" — changed)
  Use regex `".*Save [0-9]+ matched.*"`
- Cancel button: "Cancel"

## VariantMetadataEditor (appears below Variants list after a Variant is selected)
- Section heading: "Metadata" (small caps, gray)
- Insert checkbox: label "Insert" (read-only/disabled)
- Parallel checkbox: label "Parallel" (read-only/disabled)
- Prefix field: label "Prefix:", input placeholder "e.g. DK-"
- Save button: "Save" — only visible when the Prefix field is dirty (has unsaved changes)
- After save: "Save" disappears, dirty flag clears

## Custom entry button
- Label: "+ Custom" (requires regex escape in tapOn: `"\\+ Custom"`)
- assertVisible also needs the escape: `"\\+ Custom"`
- MULTI-COLUMN INDEX RULE: When multiple columns are visible each has its own "+ Custom" button.
  They appear in DOM order (left to right). Use `index: N` to target the correct column's button.
  After drilling to Insert with Variants column visible: Sets col=index 0, Variant Types col=index 1, Variants col=index 2.
  Tapping the wrong index adds an entry to the wrong level (e.g., a Variant Type instead of a Variant).

## Custom entry form
- Heading: "Add Custom Entry"
- Input placeholder: "Enter custom value..."
- Submit button: "Add"
- Cancel button: "Cancel"
- Error banner (on failure): shown in a red box, text varies

## Platform badges on items
- "SL" — SportLots
- "BSC" — BuySportsCards
- "Custom" — user-created entry (blue badge)

## Empty state text (EntitySelector, no items, no search)
- Pattern: "No [title.toLowerCase()] available. Sync from marketplaces to populate."
- Example: "No sports available. Sync from marketplaces to populate."

## Search field (appears when list has more than 8 items)
- Placeholder: "Search [title.toLowerCase()]..."
- Example: "Search sports..."

## No search results text
- "No matches found"

## Loading state
- "Loading [title.toLowerCase()]..." (while Convex query is fetching)

## Cards panel (CardChecklist) — full-width below selector row
- Panel heading: "Cards" (with count in parentheses when items exist, e.g., "Cards (42)")
  IMPORTANT: The h2 renders as `Cards{" "}` (with trailing space). Maestro's `scrollUntilVisible: "Cards"`
  is UNRELIABLE because it may not match the heading through the internal DOM structure.
  Use the empty-state paragraph text or a unique button as the scroll target instead.
- Empty state: "No cards in this checklist yet." + button "Fetch from Marketplaces"
  Reliable assertion: `assertVisible: "No cards in this checklist yet."` or `assertVisible: "Fetch from Marketplaces"`
- Button label states (mutually exclusive, same element):
  - "Fetch from Marketplaces" — empty checklist (cards.length === 0)
  - "Refresh" — populated checklist (shown in bottom action row as secondary button)
  - "Fetching..." — fetch in progress
  - "Saving..." — commit in progress after dialog confirm
- Success message (no unknowns path): `".*Saved [0-9]+ cards.*"` — appears in blue banner
- Cancel message (after cancelling dialog): exact text `"Fetch cancelled — no cards saved."`
- Error message (fetch failure): `"Error: <message>"` or `"Commit failed: <message>"`
- BSC no-sellerId error: `".*BSC.*not configured.*|.*BSC.*sellerId.*|.*Connect your BSC account.*"`
- Last synced text: "Last synced: [date]"
- Stale indicator (if >7 days old): "(stale)" in amber
- Sync message banner: shown in a blue box after fetch completes
- Refresh button (visible once cards exist): "Refresh"
- Add card button: "Add Card"

## UnknownEntitiesDialog (modal — triggered by fetch finding new players/teams)
- Open condition: `fetchCardChecklist` returns unknownPlayers.length > 0 OR unknownTeams.length > 0
- Modal role: `role="dialog"`, aria-labelledby="unknown-entities-title"
- Title: `"Confirm New Players & Teams"` (the &amp; renders as &)
- Subtitle regex: `".*we don't have yet for.*"` (includes sport name)
- Section headings: `"New Players (N)"`, `"New Teams (N)"`
- Empty section text: `"No new players in this fetch."`, `"No new teams in this fetch."`
- Checkbox rows: each player/team name appears as visible label text (checked = included by default)
- Footer count: `".*will be created.*"` — decreases when items are unchecked
- Confirm button: `".*Confirm [0-9]+ & Save.*"` regex (shows count of included items)
  - When ALL items unchecked: `"Skip All & Save"` (no regex needed)
  - While saving (committing): `"Saving..."` (disabled)
- Cancel button: `"Cancel (Esc)"` (exact text — the Esc reminder is in the button label)
- Confirm button is auto-focused on open (confirmButtonRef.current?.focus())
- Enter on the dialog container div → handleConfirm (NOT a window keydown — pressKey: Enter MAY work)
- Escape on document → onCancel (document-level listener — pressKey: Escape does NOT work in Maestro web)
- Use `tapOn: ".*Confirm [0-9]+ & Save.*|Skip All & Save"` to hit the confirm regardless of count
- Use `tapOn: "Cancel (Esc)"` to hit cancel (NOT `tapOn: "Cancel"` — the button text includes "(Esc)")

## CardChecklistItem — card row fields
- Card number: `#<cardNumber>` in mono font, e.g., `".*#[0-9].*"` regex
- Sub-line format: `<team> · /<printRun> · <cardVariation> · <autographType> auto`
  Example: `"Yankees · /99 · Refractor · On-Card auto"`
- Attribute badges (text): `"RC"`, `"AU"`, `"RELIC"`, `"SP"`, `"SSP"`, `"#'d"`, `"SL only"`, `"BSC only"`
  NOTE: `"unmatched-bsc"` token → badge label `"SL only"` (cards that came only from BSC are SL-missing)
         `"unmatched-sl"` token → badge label `"BSC only"`
- Platform badges: `"SL"`, `"BSC"`, `"Custom"` (Custom = isCustom=true, blue badge)
- Hover-only actions: `"Edit"`, `"Del"` (opacity-0 until hover — may not be assertVisible in headless)

## Add Card form (CardChecklist)
- Card number field placeholder: "#"
- Player name field placeholder: "Player name"
- Team field placeholder: "Team (optional)"
- Submit button: "Add"
- Cancel button: "Cancel"

## Card row (CardChecklistItem) — NEO-26 update
- Card number shown as: "#[number]" (e.g., "#42")
- Actions revealed on hover: "Edit", "Del"
- Delete confirm prompt: "Confirm?" (replaces "Del" button)
- Edit form: uses `aria-label={`Edit card ${cardNumber}`}` on the Edit button → `id: "Edit card 42"` in Maestro
- Delete button: `aria-label={`Delete card ${cardNumber}`}` → `id: "Delete card 42"` in Maestro
- Confirm delete button: `aria-label={`Confirm delete card ${cardNumber}`}` → `id: "Confirm delete card 42"` in Maestro
- Edit form card name input: `aria-label="Card name"` → `id: "Card name"` in Maestro
- Edit form save button: `aria-label="Save card edit"` → `id: "Save card edit"` in Maestro
- Edit form cancel button: `aria-label="Cancel card edit"` → `id: "Cancel card edit"` in Maestro
- NEO-26: The old "Team" free-text input is GONE. Team is now TeamPicker (chip-list).
- Sub-line format: `<team(s)> · /<printRun> · <cardVariation> · <autographType> auto`
  Team names are resolved from teamOnCardIds[] → displayed comma-separated

## TeamPicker (NEO-26 chip-list component)
- Container: `aria-label="Team picker"` → `id: "Team picker"` in Maestro
- Chip label span: `aria-label={`Team: <name>`}` — but use the visible text to assert chip presence
- Remove chip button: `aria-label={`Remove team <name>`}` → `id: "Remove team New York Yankees"` in Maestro
- Add team trigger: `aria-label="Add team"` → `id: "Add team"` in Maestro; visible text "+ Add team"
- Typeahead popover (opens on trigger click):
  - Search input: `aria-label="Search teams"` → `id: "Search teams"` in Maestro
  - Match button: `aria-label={`Add <name>`}` → visible text IS the team name → `tapOn: text: ".*Yankees.*" index: 0`
  - Empty search state: visible text "Start typing a team name…"
  - No matches state: visible text "No matches." (when query typed but no results)
  - Loading state: visible text "Loading…"
- Keyboard: Enter on focused match button selects it; Escape closes popover; Backspace on empty input removes last chip
- `pressKey: Enter` works for confirming the highlighted result (keyboard path tested via Enter after typing query)
- Team names in the picker are sport-filtered (passed in `sport` prop from ancestor chain)

## CardFeaturesEditor (NEO-24 per-card features)
- Collapsed trigger: `aria-label="Show features editor"` → `id: "Show features editor"` in Maestro; visible text "Show features ▾"
- Editor container: `aria-label="Card features editor"` → `id: "Card features editor"` in Maestro
- Hide button: `aria-label="Hide features editor"` → `id: "Hide features editor"` in Maestro; visible text "Hide ▴"
- Feature row (label element): `aria-label={`Feature ${label}`}` → e.g. `id: "Feature League"` in Maestro
- Feature value input: `aria-label={`Value for ${label}`}` → e.g. `id: "Value for League"` in Maestro
- Revert button: `aria-label={`Revert ${label} to inherited`}` → e.g. `id: "Revert League to inherited"` in Maestro
- Inherited value label: `aria-label={`Inherited value: ${inheritedValue}`}` → visible text "Inherited: <value>"
- Missing feature icon: `aria-label="Missing required feature"` → `id: "Missing required feature"` in Maestro; visible text "⚠"
- Missing feature highlight: amber border + bg-amber-500/5 (visual, not assertable via text)
- AMBIGUITY WARNING: Both CardFeaturesEditor and SetFeaturesPanel use `aria-label={`Value for ${label}`}` on their inputs.
  When both are in the DOM (card edit form open + SetFeaturesPanel below), `tapOn: id: "Value for League"` hits the
  CardFeaturesEditor's input (earlier in DOM order). Always `scrollUntilVisible: element: id: "Value for League"` first.

## SetFeaturesPanel (NEO-24 set-level features)
- Panel container: `aria-label="Set features panel"` → `id: "Set features panel"` in Maestro
- Panel heading: visible text "Set features" (h3)
- "Will propagate to N cards" counter: `aria-label={`Will propagate to ${N} descendant cards`}`
  Visible text pattern: "Will propagate to N cards" or "Counting…"
- setMetadata chips container: `aria-label="Set metadata chips"` or `aria-label="No set metadata yet"` (empty state)
  Empty state text: "No set metadata yet — pending sync."
  Chip labels (uppercase, visible): "Released", "Cards", "Block", "TCDB SID", "Synced"
- Feature row (label element): `aria-label={`Set feature ${label}`}` → e.g. `id: "Set feature League"` in Maestro
- Feature value input: `aria-label={`Value for ${label}`}` → same as CardFeaturesEditor! (see AMBIGUITY WARNING above)
- Missing feature icon on set row: same `aria-label="Missing required feature"` as CardFeaturesEditor
- Save toast: `role="status"` aria-live="polite"; text pattern "Updated N cards" or "Updated N cards; skipped M with overrides"
  Toast auto-dismisses after 6 seconds.
- SetFeaturesPanel renders BELOW the MultiSourcePanel and the card columns. Always scroll down to reach it.
- Active condition: renders whenever a setName-level row (level 4, "Topps Chrome") is selected.
  Selecting a variant type does NOT close SetFeaturesPanel — it stays visible below.

## EXPECTED_FEATURES keys (from convex/features/expectedFeatures.ts)
- "league" / "League" — applicableSports: Baseball, Basketball, Football, Hockey
- "era" / "Era"
- "isReprint" / "Reprint"
- "cardType" / "Card Type"
- "signedBy" / "Signed By"
- "isRookie" / "Rookie Card"
- "isRelic" / "Memorabilia Relic"
- "parallelName" / "Parallel/Variety"
- "vintage" / "Vintage"
- "manufacturer" / "Manufacturer"

## EntitySelector column — internal scroll container (IMPORTANT)
Each column (Sports, Years, Manufacturers, etc.) has its OWN internal scroll container.
`scrollUntilVisible` at the page level CANNOT reach items inside the column's internal scroll.
To find items that may be off-screen within a column: USE THE SEARCH BOX.
- The search box placeholder is "Search [column name]..." (e.g., "Search sports...")
- Tap the placeholder text to focus, `inputText: "keyword"` to filter
- The item will appear even if it would normally require internal scrolling
- After searching: reload the page (`openLink: .../set-selector`) to reset the search state
  (You cannot reliably tap the search input by text when it has a value, because the
  placeholder text is not visible in Maestro's DOM when the field has content)

## Column visibility rules
- Sports column: always visible
- Years column: visible only after a sport is selected
- Manufacturers column: visible only after a year is selected
- Sets column: visible only after a manufacturer is selected
- Variant Types column: visible only after a set is selected
- Variants column: visible only after a non-Base variant type is selected
  CRITICAL (PR #25): When "Base" is selected at Level 5, the Variants column is SUPPRESSED.
  BaseMappingForm auto-mounts on the variantType row. BaseSetPicker opens immediately.
  After confirming "Confirm Base Set", `baseHasMapping` becomes true and CardChecklist renders
  DIRECTLY attached to the variantType row — no Level 6 selection needed.
  Never write `extendedWaitUntil: visible: "Variants"` or try to tap Level 6 items after "Base".
- Sub-Variants column: visible only after a variant is selected (optional)
- Cards panel: visible only after a variant (or sub-variant) is selected

## SL/BSC pills — terminal items only (PR #25 change)
SL and BSC text pills now appear ONLY on terminal items:
- Terminal: Base variantType rows, Variants entries, parallels
- Non-terminal: Sports, Years, Manufacturers, Sets, Variant Types → NO pills

Never `assertVisible: "BSC"` or `assertVisible: "SL"` at the Sports/Years/Manufacturers/Sets/VariantTypes levels.
To verify a Sports column sync wrote data: `assertVisible: "Baseball"` instead.

## Collapsed selector pill
- When a value is selected and the column collapses, shows the selected value text and a chevron-down icon
- Tapping the pill re-expands the column

## Profile credential pages (relevant text)
- Platform selector: "Select Platform" (label), "BuySportsCards" (default), "Sportlots" (option)
- Platform selector id: "site-select"
- BSC username field: "BuySportsCards Username" (label), id="username"
- BSC password field: id="password"
- Sportlots username field: "Sportlots Username" (label), id="username"
- Save button: "Save Credentials"
- Saved state banner: ".*Credentials saved.*" (BSC), ".*Credentials saved for Sportlots.*" (SL)
- Clear button: "Clear Credentials"
- Clear confirm: "Yes, Clear"
- Cleared confirmation: ".*Credentials cleared.*"
- Test button: "Test Credentials"
- BSC test success: ".*BSC account authenticated successfully.*"
- SL test success: ".*Successfully logged into SportLots.*"

## Maestro web: aria-label resolution (CRITICAL)

Maestro web maps `aria-label` to `resource-id` in the accessibility hierarchy, NOT to the `text` attribute.

Consequence:
- `tapOn: "aria-label-value"` (plain string) uses text regex matching → FAILS for aria-label-only elements
- `tapOn: {id: "aria-label-value"}` uses resource-id matching → WORKS
- `scrollUntilVisible: element: text:` also uses text only → cannot scroll to aria-label-only elements
- Visible DOM text (e.g. button inner text) IS matched by plain string `tapOn`

Rule: if a button has BOTH visible text and an aria-label, tap by the visible text. If the button's only accessible name is the aria-label (no visible text, or ambiguous visible text), tap by `{id: "aria-label-value"}`.

## ParallelGroupingModal — accessible selectors (post-restructure May 2026)

- "Group Parallels" trigger button: plain visible text → `tapOn: "Group Parallels"` with preceding `scrollUntilVisible: element: text: "Group Parallels"`
- "+ Custom" button in Variants column: visible text is `"+ Custom"` (ambiguous — all 3 columns have it). aria-label is `"Add custom Variants"` → `tapOn: {id: "Add custom Variants"}`
- "+ Custom" button in Variant Types column: aria-label `"Add custom Variant Types"` → `tapOn: {id: "Add custom Variant Types"}`
- "+ Custom" button in Sets column: aria-label `"Add custom Sets"` → `tapOn: {id: "Add custom Sets"}`
- ✕ reject parallel button: aria-label `"Remove <value> from parallels"` → `tapOn: {id: "Remove Stars Gold from parallels"}`
- Modal open signal (unique text): `".*Drag inserts under a parent.*"` (NOT "Group Parallels" which is also on the trigger button)
- Modal footer — no changes: `"No changes yet"` (status text), `"No changes"` (disabled save button)
- Modal footer — with changes: `".*N promotion.*"`, `".*Save N change.*"`
- Accept all button: `".*Accept all suggestions.*"`
- Suggested badge text: `"Suggested"` (appears inside suggested rows)
- Parallels zone heading EXACT: `Parallels of "Stars"` (double-quotes around the insert name are part of the title). YAML: `Parallels of \"Stars\"`. Zone-relative assert: `assertVisible: text: "Stars Gold" below: "Parallels of \"Stars\""`.
- Top-level inserts zone: `"Top-level inserts"`. Zone-relative: `assertVisible: text: "Stars" below: "Top-level inserts"`.
- CRITICAL: After modal Close/Cancel/backdrop, EntitySelector columns collapse to selected-pill state — list rows are NOT in the DOM. Never `assertVisible`/`scrollUntilVisible` for row text (Stars/Gold/Red) after modal close. Assert action-button row instead: `id: "Add custom Inserts"` + `"Group Parallels"`. The cancel-discards proof of no-persist is established by the reopen→Suggested cycle, not a post-close row assertion.

## CardDetailPanel (NEO-25) — right-anchored drawer

Replaced the per-row inline edit modal (CardChecklistItem) with a single right-anchored drawer.
Selection state hoisted into CardChecklist; panel is keyed on card._id so switching remounts it.

### Opening
- `id: "Edit card {cardNumber}"` (row Edit button aria-label) — unchanged from old modal
- `id: "Open card {cardNumber}"` (new — clicking the card body row also opens it)

### Drawer header
- Title visible text: `"Card #{cardNumber}"` (e.g. `"Card #777-abc"`) — NEO-25 change; old modal said `"Edit card #..."`.
  Assert with regex: `".*Card #{cardNumber}.*"`
- Prev button: `id: "Previous card"` (↑ arrow)
- Next button: `id: "Next card"` (↓ arrow)
- Close (×) button: `id: "Close card detail"` — DIRTY-GUARDED (shows inline confirm if dirty)

### Editable fields
- Card name input: `id: "Card name"` (same as before) — autofocused on open.
  IMPORTANT: Does NOT save on Enter (NEO-25 delta 4). Use `id: "Save card edit"` button.
- Attribute toggle chips (aria-pressed): `id: "Toggle RC"`, `id: "Toggle AU"`, `id: "Toggle RELIC"`,
  `id: "Toggle SP"`, `id: "Toggle SSP"`, `id: "Toggle NUM"` — active when aria-pressed="true".
  Visible text for all chips: "RC", "AU", "RELIC", "SP", "SSP", "#'d".
- Print run input: `id: "Print run"`, placeholder `"e.g. 99"`, visible label "Print run (/N)"
- Autograph type input: `id: "Autograph type"`, placeholder `"On-Card / Sticker / Cut"`
- Card variation input: `id: "Card variation"`, placeholder `"e.g. Gold Refractor"`, label "Variation / parallel"
- Card title input (listingTitle): `id: "Card title"`, placeholder `"Listing title reused across marketplaces"`
  Shows char count badge `"{N} chars"`; turns neon-pink (FF2EB3) if >80 chars.
- Card description textarea (listingDescription): `id: "Card description"`, `rows: 3`

### Read-only sections
- Players section: shows player name chips or `"None linked. Add players via the marketplace fetch flow."`
- Inherited from set: shows Sport/Year/Manufacturer/Set/Variant labels + values in a `<dl>`; no id needed, read-only.
- CardFeaturesEditor is embedded at the bottom (same UI patterns as standalone — see section above).
  Note: `id: "Value for League"` inside the drawer hits the embedded CardFeaturesEditor
  (same aria-label as SetFeaturesPanel). CardFeaturesEditor persists immediately (no Save cycle).

### Footer — normal state
- Save button: `id: "Save card edit"` — closes drawer on success.
- Cancel button: `id: "Cancel card edit"` — closes IMMEDIATELY (no dirty guard, unlike × and backdrop).

### Footer — dirty-guard confirm bar (shows when × or backdrop clicked while dirty)
- Bar appears when `pendingAction` is set (dirty + exit requested via × / backdrop / prev / next).
- Visible label text: `"Discard unsaved changes?"`
- Keep editing button: `id: "Keep editing"` — dismisses bar, drawer stays open.
- Discard changes button: `id: "Discard changes"` — discards edits and runs the pending action.

### Dismiss behaviors (CRITICAL delta from old modal)
| Action | When clean | When dirty |
|---|---|---|
| Cancel button | closes immediately | closes immediately (no guard) |
| Escape key | closes immediately (document listener — discards) | closes immediately (discards) |
| × button | closes immediately | shows dirty-guard bar |
| Backdrop click | closes immediately | shows dirty-guard bar |
| Prev/Next buttons | navigates immediately | shows dirty-guard bar |

### Backdrop tap in Maestro (1024×629 viewport)
The panel is right-anchored, ~480px wide at 1024px. Tapping `point: "5%, 50%"` reliably lands on the
backdrop layer (left side, well outside the panel). Use this to test the dirty-guard behavior.

### Card number range convention
Custom test cards: 700-999. Each flow picks a unique number, deletes the card on cleanup.
flow→number mapping: edit-and-delete=777, team-picker=889, card-features-missing=991,
features-propagation=992, card-detail-panel=888.
