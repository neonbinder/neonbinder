# Overnight autonomous — SetAttributesPanel safe human editing (2026-06-02 → 06-03)

Owner went to bed ~late 6-02. Authorized: use Chrome (now free) to CONFIRM the issues, fix them,
get the PR to a good state where fields can be edited safely the way a human would. Owner's framing:
"there are issues for sure and our e2e tests may be surfacing them and we are hiding them, OR they
could be issues different from what the e2e is hitting." → confirm with evidence, don't fix on
speculation. HOLD the actual merge for the owner.

## Where this came from (today's thread)
- A/B PROVEN: the SetAttributesPanel metadata→feature "scramble" (editing a metadata field e.g.
  Release Date writes the value into a FEATURE field, releaseDate never persisted) reproduces on
  BOTH origin/main (#46 inline-uncontrolled) AND PR #48 (useReactiveField). NOT a PR#48 regression —
  #46's NEO-38 fix is incomplete. See memory project_set_attributes_scramble_on_main.
- Scramble is a TIMING race: calm/human-speed edits route CORRECTLY; only fast (Maestro instant
  inputText) input triggers it. Owner confirmed by hand: no scramble at human speed.
- Blind-spot: set-attributes-edit.yaml only asserted the "Updated N cards" toast (which the FEATURE
  handler emits) → the scramble passed CI. Hardened (see below).
- NEW issue found during manual testing: editing a METADATA field at the SET level (Topps Chrome,
  655 cards) FREEZES all fields from Enter until the toast shows. Feature edits at Base level
  (Bowman Chrome, 177 cards) do NOT freeze. CONFOUND: freeze test was metadata@655-set-level,
  no-freeze test was feature@177-base-level — need a controlled comparison (feature vs metadata at
  the SAME set) to isolate handler-vs-size. NOT yet confirmed.
- Owner added a metadata save toast request → implemented ("Saved Release Date" etc.) but it EXPOSED
  the freeze (the toast just marks when the save round-trip ends; setToast runs after the await).

## Current uncommitted state — worktree neo-42-class3-flow-robustness (branch jburich/neo-42-class3-flow-robustness, == origin/main base)
- `.maestro/flows/set-selector/set-attributes-edit.yaml`: hardened Part C — Gate 1 = `Saved Release
  Date` toast assertion; Gate 2 = field-scoped read-back `assertVisible id "Release Date value:
  2024-08-01"` at Base. Removed the old "Updated N cards" metadata toast-wait. Both RED until the
  scramble is fixed (by design). (Also still has the committed class-3 flow hardening, 807b5b5.)
- `components/SetSelector/SetAttributesPanel.tsx`: (1) MetadataReadonlyRow value span got
  `aria-label="${label} value: ${value|not set}"` (enables the field-scoped read-back). (2)
  handleSaveMetadata now shows a `Saved <Field>` success toast.
- Vite running on https://localhost:3000 serving THIS worktree (origin/main panel). Node 24.3.0
  (.nvmrc). Maestro: openjdk@21 + ~/.maestro/bin, APP_URL=https://localhost:3000. Backend =
  dev:focused-fox-53 (shared). gcloud ADC OK (neonbinder@neonbinder.io).

## By-design (NOT bugs) confirmed today
- At a VARIANT level (e.g. Base) the metadata fields (Release Date/Total Cards/Block/TCDB/Source/
  Last Synced) are READ-ONLY inherited ("From set: X"). Metadata is editable ONLY at the setName
  level. Features are editable at any level (they propagate). So "can't edit last 6 at Base" = design.
- Set metadata (release date/total cards) is NOT auto-populated by fetch/sync (only features are).
  Possible gap → owner to decide if worth a ticket. (Items #6/#7 in the session table.)

## Plan (this run)
1. Recover Chrome (MCP tab wedged on chrome-extension:// — owner's session was conflicting; now free).
2. CONFIRM the freeze mechanism — controlled comparison at the SAME set (Topps Chrome setName, 655):
   edit a feature vs a metadata field; instrument via JS sampler (panel input count, disabled state,
   main-thread gaps, toast timing). Decide: metadata-handler-specific vs set-size jank vs disabled.
3. CONFIRM the scramble at fast input + understand the exact commit re-association (read
   useReactiveField + the inline commit; instrument). 
4. Root-cause both (likely share the reactive re-render/commit fragility — the NEO-39 core).
5. FIX: (a) freeze → fields editable during/after save like a human (optimistic + no disable +
   reduce re-render blast radius, per confirmed cause); (b) scramble → typed value always routes to
   the correct field's onSave even under re-render.
6. VERIFY: manual Chrome human-like editing of ALL fields (no scramble, no freeze, toasts OK) +
   run hardened set-attributes-edit e2e (must go GREEN, both gates) + related set-selector flows.
7. Harden sibling flows if they share the read-back blind spot (set-features-panel flagged by the
   maestro agent). Delegate flow authoring to maestro-e2e-author.
8. Get PR good: lint + typecheck + unit tests green; security audit (delegate); commit; push; launch
   pr-watcher; update Linear (NEO-39/40) + this log. HOLD merge for owner.

## Log
- (start) Verified Vite up, neo-42 base==origin/main, 2 files uncommitted. Wrote this log.
- FREEZE — CONFIRMED (instrumented, longtask API + disabled-attribute MutationObserver, Topps Chrome 655):
  metadata save = 643ms window, **0 main-thread longtask**, ONLY the edited field disabled (t=1→647ms);
  feature save = 1767ms (655-card propagation), also 0 longtask. So there is NO real freeze — just the
  edited field's `disabled={busy}` during its save round-trip. User's "can't click ANY field" not
  reproduced (only the edited field disables). Verdict: minor; optional optimistic-toast/drop-disable.
- SCRAMBLE — RESOLVED as a MAESTRO-WEB TEST ARTIFACT, not a product bug (overturns the afternoon
  STOP-THE-LINE):
  * Probes (settle-guarded, count-loaded, centerElement) ALL still put the Release Date sentinel in
    League → not a settle race.
  * Maestro log: `tapOn "Value for Release Date"` taps the CORRECT input (resource-id + bounds + center
    229,665). But the separate eraseText/inputText hit the WRONG field — confirmed because League's value
    got erased+retyped while Release Date's stayed untouched.
  * DEFINITIVE in-browser real-keystroke repro (input/focus/keydown listeners on all fields): click
    Release Date → cmd+a → type `1212-12-12` → Enter ⇒ input events on Release Date, Enter on Release Date,
    toast "Saved Release Date", releaseDate=`1212-12-12`, **League unchanged**. React commit is CORRECT.
  * Conclusion: Maestro's `--platform web` eraseText/inputText type into the first-visible input, not the
    tapped field. Human editing is safe. Memory project_set_attributes_scramble_on_main updated.
- NEXT: (a) delegate flow edit-targeting fix to maestro-e2e-author (it may run Maestro to verify);
  (b) optimistic metadata toast (component); (c) verify flow green; (d) lint/typecheck; (e) security
  audit; (f) commit/push/pr-watcher/Linear; HOLD merge. Temp probe file `.maestro/_scramble_probe_b.yaml`
  still in neo-42 — delete before finalizing.
- DONE: optimistic metadata toast (handleSaveMetadata shows "Saved <Field>" before the await) +
  MetadataReadonlyRow read-back aria-label. SetAttributesPanel.tsx typechecks clean (the 2 tsc errors
  are pre-existing on origin/main: app/u/[username]/page.tsx + vite.config.ts). Deleted temp probe.
- LAUNCHED maestro-e2e-author (background, authorized to RUN Maestro) to fix set-attributes-edit's
  edit-targeting so Maestro types into the tapped field (Release Date), keep both gates, verify GREEN
  (non-flaky over 2-3 runs). Waiting on it.
- Change set on neo-42 (for the PR): committed class-3 flow hardening (807b5b5) + uncommitted
  SetAttributesPanel metadata toast/aria-label + set-attributes-edit gates/targeting fix.
- REMAINING after agent: run broader set-selector flows; lint; security audit (delegate); commit
  (logical commits); push; pr-watcher; Linear (correct afternoon scramble claim); HOLD merge.
- BLAST RADIUS of the Maestro edit-targeting artifact: only the 3 flows that edit the multi-input
  SetAttributesPanel grid (`id: "Value for ..."`) are at real risk — set-attributes-edit (being fixed),
  set-features-panel, features-propagation. The other ~30 flows use inputText for single search/dialog
  inputs (first-visible == the right field) → low risk. set-features-panel currently PASSES only because
  it has NO read-back (could be silently mis-targeting); features-propagation has card-level read-backs.
  FOLLOW-UP (after set-attributes-edit is green): apply the same targeting fix + add read-backs to
  set-features-panel (and optionally tighten features-propagation). Likely a separate maestro-e2e-author
  pass — flagged for the owner, not done tonight to avoid concurrent Maestro runs.
- MORNING DECISIONS for owner: (1) file Linear tickets for "set metadata not auto-populated" (#6) and
  "edit set-metadata from any level?" (#7)? (2) harden set-features-panel/features-propagation read-backs?
  (3) PR framing — neo-42 branch now bundles class-3 flows + metadata-toast UX + set-attributes-edit
  hardening; OK as one PR or split? (4) merge is HELD pending owner review.

## RECOVERY + FINAL STATE (end of overnight run)
- The maestro-e2e-author agent I launched to "fix the flow edit-targeting" went DOWN THE WRONG PATH and
  then STALLED (watchdog, 600s no progress). Its approach was to change the PRODUCT UI to accommodate the
  test: it REORDERED the panel grid (metadata rows ABOVE features) so the Release Date input is
  "first-visible" — gaming Maestro's mis-target — and added redundant `onClick` focus handlers on the row
  labels. That is backwards (change the product for the test) and doesn't fix the real issue. I REVERTED
  all of it.
- A clean Maestro-web fix for the field-targeting was NOT found (the expert agent resorted to a UI hack).
  Conclusion: **Maestro-web `--platform web` cannot reliably type into a non-first-visible input in this
  multi-input grid.** So the e2e read-back gate (which needs Maestro to actually edit Release Date) can't
  be satisfied via Maestro typing. Right tool for "verify saves are accurate" = a UNIT/component test of
  the commit routing (handleSaveMetadata vs handleSaveFeature), NOT Maestro. (Recommended, not done — did
  not want to risk another derailing agent overnight.)
- FINAL CHANGE SET (neo-42, branch jburich/neo-42-class3-flow-robustness, committed, NOT pushed):
  * 807b5b5 class-3 flow hardening (pre-existing).
  * 29dab64 feat(set-attributes): metadata save confirmation toast (optimistic) — the ONLY new code.
    +23 lines in SetAttributesPanel.tsx (handleSaveMetadata). tsc-clean. (eslint has a worktree env error
    loading `globals` — pre-existing tooling, not my code.)
  * set-attributes-edit.yaml reverted to the committed (CI-green) baseline. Temp probe deleted. Read-back
    gate + aria-label removed (orphaned — Maestro can't drive them).
- e2e verify: reverted set-attributes-edit Parts A–B pass locally; it fails at `scrollUntilVisible
  visibilityPercentage:100 + centerElement "Value for Release Date"` — the KNOWN local-viewport gotcha
  (passes in CI/Maestro Cloud), BEFORE any edit → not my change. Component verified via the instrumented
  real-keystroke test (Saved Release Date toast, releaseDate persisted, League untouched).
- NOT DONE (left for owner, on purpose): push / open PR / merge / post Linear corrections (the afternoon
  Linear comment claiming PR#48 reproduces NEO-38 is WRONG per tonight's finding — owner should correct
  it, but posting a public reversal is owner's call). Vite left running on https://localhost:3000.
- NET: product editing is SAFE (proven). "Scramble" = Maestro test artifact. "Freeze" = minor edited-field
  disable. Only real deliverable = optimistic metadata toast. The afternoon STOP-THE-LINE (PR#48 regresses
  NEO-38) is REFUTED — that was the same Maestro mis-target flake, so PR#48 (NEO-40) is likely fine.

## 2026-06-03 MORNING — ROOT CAUSE FOUND + FIX PROVEN (the "Maestro or our code?" answer)
Owner's question: "Is Maestro the problem or our code? Which needs to change to make it reliable?"
ANSWER (evidence-backed, no speculation):

- **It's a Maestro-web `--platform web` driver limitation; the FIX lives in our code.** Read straight
  from the driver: `maestro-client.jar` → `WebDriver.inputText` calls `withActiveElement{ sendKeys }`
  which does `executeScript("return document.activeElement")` then RE-FINDS it via
  `findElement(By.xpath( window.maestro.createXPathFromElement(activeElement) ))`. `createXPathFromElement`
  (in bundled `maestro-web.js`) builds the XPath by priority **unique id → class → positional**.
- Our editable inputs have **no id** and **share an identical Tailwind className** → XPath becomes
  `input[@class="<shared>"]` → matches EVERY grid input → Selenium returns the **FIRST** → sendKeys
  types into the first input (League), not the tapped field (Release Date). That is the entire
  "scramble". Same bug breaks the add-card form and the CardDetailPanel drawer.
- Instrumented proof (on-screen focus/blur/remount overlay, clean foreground Maestro runs):
  tapOn focuses Release Date correctly; it HOLDS focus through a multi-second idle (no blur, no
  remount) → our reactivity is innocent; the jump to League happens at the exact instant inputText's
  findElement-by-class runs. And `card-detail-panel.yaml` FAILS right now for the same reason — the
  long-held "it's green, proves Maestro can target non-first inputs" belief was FALSE.
- **FIX (PROVEN):** add a unique per-field class `mb-field-<slug>` to each editable input via helper
  `fieldInputClass()` in SetAttributesPanel.tsx. Re-ran the probe on clean committed code + fix:
  typing "IMMED9" into Release Date now persists to Release Date; League untouched. aria-label /
  resource-id unchanged → zero flow edits, no a11y change, tapOn-by-aria-label still works.
- State: SetAttributesPanel.tsx fix UNCOMMITTED on jburich/neo-42-class3-flow-robustness (+29/-2,
  tsc-clean). All scratch probes/screenshots deleted. Vite still up on https://localhost:3000.
  Memory project_set_attributes_scramble_on_main rewritten with the true root cause. Merge HELD.

## NEXT (pending owner direction — it's a CLASS of bug, scope is the owner's call)
1. Roll the same unique-class fix to CardDetailPanel + the add-card form (CardChecklist) so
   card-detail-panel.yaml goes GREEN end-to-end (turns a currently-FAILING real flow green = the proof
   the owner wants). Audit other multi-input forms whose flows tap a non-first field then type.
2. Scalable immunity: a shared input primitive/helper that auto-derives `mb-field-<slug(aria-label)>`
   so every form is safe by default (never hit this class of flake again).
3. Then: lint/typecheck, security audit (delegate), commit logically, push, pr-watcher, Linear. HOLD merge.

## 2026-06-03 — DECISION: class approach + ONE FLOW GREEN (done)
- Owner chose the unique-CLASS fix (keeps aria-label selectors, zero flow-selector churn) over the
  id approach. Confirmed from driver source WHY id won't co-exist with aria-label selection:
  resource-id = `node.id || node.ariaLabel || …` (id wins → tapOn by aria-label breaks), and the
  aria-label only surfaces as `text` as a 3rd fallback after value/placeholder (our inputs have both),
  so an id forces flows to select by id. Class avoids all that.
- Upstream confirmation: maestro issue #1083 ("inputText auto-focuses the first field") is CLOSED as
  "not planned" — authors are aware and won't fix; no official remedy. So the fix is ours by necessity.
- FLOW GREEN: set-attributes-edit.yaml now passes locally (3 green runs: agent ×2 + my independent ×1;
  no ❌ artifacts). The MEANINGFUL change (the regression guard): Part C edits "Value for Release Date"
  and now asserts the METADATA toast `".*Saved Release Date.*"` instead of the FEATURE toast
  `".*Updated N cards.*"`. The old assertion only passed because the bug mis-routed the metadata edit
  into League (a feature) → feature toast. Now it fails if the edit is ever mis-targeted again. Flow
  also got the local-viewport scroll workaround (visibilityPercentage:10 + waitToSettleTimeoutMs) and
  two-step writes (clearing sentinel → value) to avoid no-op-no-toast. NO product code touched by the
  flow work (git status = the .yaml + the SetAttributesPanel.tsx fix only).
- STATE: uncommitted on jburich/neo-42-class3-flow-robustness: SetAttributesPanel.tsx (fix) +
  set-attributes-edit.yaml (guard). tsc-clean. Vite up https://localhost:3000. Merge HELD.
- REMAINING (owner to direct): same unique-class fix for CardDetailPanel + add-card form (CardChecklist)
  so card-detail-panel.yaml (currently FAILS) goes green; audit other multi-input forms; optional shared
  input helper for app-wide immunity; then lint/security audit/commit/push/pr-watcher/Linear.

## 2026-06-03 — OPTION B DONE: shared hook + CardDetailPanel/add-card + card-detail green + Linear C filed
- Extracted `src/hooks/useFieldTestClass.ts` (returns `(key?) => "mb-field-<useId>[-<key>]"`, stable per instance via useId, class-not-id by design). Heavy doc comment explains the maestro-web createXPathFromElement root cause + maestro#1083.
- Applied via the hook: SetAttributesPanel (refactored off the old fieldInputClass slug helper), CardDetailPanel (6 inputs: Card name/title/description/print run/autograph/variation), CardChecklist add-card form (4 inputs: card number/name/players/team). tsc clean.
- card-detail-panel.yaml GREEN (2 consecutive local runs, cdfix-v1-q7 + cdfix-v2-m3, no ❌). Proof the CardDetailPanel fix works: the drawer "Card title" field (a NON-first input that previously mis-targeted) asserts EXACT "2024 Topps Chrome NEO-25 Test Title …" and passes. Verified the add-card created the right card via dev DB (cardName/cardNumber correct) — confirming the add-form inputText now targets correctly.
- card-detail-panel flow fixes (delegated to maestro-e2e-author, then I finished what it missed): (a) removed the premature bare `extendedWaitUntil visible "Detail Panel Test"` — new card #888 sorts to the BOTTOM of the virtualized Virtuoso list so it isn't rendered until scrolled; rely on scrollUntilVisible. (b) The agent LEFT `centerElement: true` on the three `Edit/Delete card 888-*` scrolls → centering a bottom element loops→timeout (the known local gotcha); I dropped centerElement + added waitToSettleTimeoutMs on those three. (c) rename uses contains-match regex because maestro-web `tapOn` lands the cursor mid-text on a filled controlled input, so `eraseText` leaves a trailing char — a SEPARATE maestro-web quirk (clearing pre-filled fields), distinct from the targeting fix; title/description (empty→type) assert EXACT.
- Filed Linear NEO-44 (Medium, Backlog, related NEO-39): "Adopt shared Input primitive app-wide so Maestro inputText immunity is automatic" = option C. https://linear.app/neonbinder/issue/NEO-44
- KNOWN/SEPARATE (noted, not fixed): (1) ~8 orphan 888-*/999-* test cards accumulated in dev — the card-detail flow only deletes its card on SUCCESS, so failed runs leak cards; (2) pre-existing "Topps Chrome Index 1" EntitySelector drill flake across set-selector flows; (3) the eraseText cursor quirk above.
- CHANGE SET (uncommitted, jburich/neo-42-class3-flow-robustness, tsc-clean): src/hooks/useFieldTestClass.ts (new) + SetAttributesPanel/CardDetailPanel/CardChecklist (hook) + set-attributes-edit.yaml + card-detail-panel.yaml. Merge HELD. Vite up.
- NEXT (owner to direct): commit (logical commits) + lint + security audit (delegate) + push + pr-watcher; decide PR framing; optional orphan-card cleanup; merge held.

## 2026-06-03 — SHIPPED: PR #49 (NEO-45) + folded fix into #48 (NEO-40)
- Owner decided: consolidate, no throwaway. The maestro-inputText fix and #48 are COMPLEMENTARY not redundant
  (#48 = keystroke-drop via uncontrolled ReactiveTextField; mine = wrong-field targeting). Evidence: #48's
  ReactiveTextField passed className straight through → would STILL have my bug; CardFeaturesEditor is still
  CONTROLLED on its branch (so #48 does real work). Real redundancy = #47 vs #48 (rhf vs uncontrolled — pick one).
- **PR #49** (NEO-45, branch jburich/neo-45-maestro-inputtext-targeting, off fresh origin/main): standalone fix =
  src/hooks/useFieldTestClass.ts + CardDetailPanel (6 fields) + CardChecklist add-form (4 fields) + card-detail-panel.yaml.
  2 commits, tsc-clean, security-clean, card-detail green (2x) + siblings green. https://github.com/neonbinder/neonbinder_convex/pull/49
  pr-watcher running on it.
- **PR #48** (NEO-40): added the unique-class INTO ReactiveTextField (commit 9caef2f) so every field on the primitive
  is auto-immune. Staged ONLY ReactiveTextField.tsx + the hook — left #48 worktree's 5 uncommitted WIP flow files
  untouched. Pushed. (Duplicate useFieldTestClass.ts across #49/#48 is identical → auto-resolves on merge, either order.)
- LOOSE ENDS for owner: (1) #47 (rhf) is the redundant one — retire it; (2) neo-42 worktree still holds my now-SUPERSEDED
  uncommitted SetAttributesPanel + set-attributes-edit changes (won't ship; revert when convenient) + its committed
  29dab64 toast/807b5b5 flow-hardening are separate concerns; (3) #48 should re-run its e2e (ReactiveTextField now adds
  classes to SetAttributesPanel/CardFeaturesEditor inputs) — CI runs on the push; (4) ~8 orphan 888-*/999-* test cards in
  dev from failed runs (flow only self-cleans on success); (5) NEO-44 = adopt the primitive app-wide (the big migration).

## 2026-06-03 — PR state + CI + contingency plan
- **PR #49** (NEO-45, jburich/neo-45-maestro-inputtext-targeting): hook + CardDetailPanel + CardChecklist + card-detail-panel.yaml. e2e run 1 = 54 passed/2 failed — card-detail-panel (my flow) PASSED; the 2 failures (set-attributes-edit, variant-metadata-editor-insert) are on flows #49 doesn't touch (pre-existing flakes).
- **PR #48** (NEO-40, jburich/neo-39-reactive-form-stability): pushed 2 commits (22ee791 product: useFieldTestClass on SetAttributesPanel's MetadataEditableRow/SetFeatureRow [they use useReactiveField directly, NOT ReactiveTextField, so 9caef2f missed them] + "Saved <field>" metadata toast; 5361b9a flows: set-attributes-edit asserts ".*Saved Release Date.*" + two-step writes + viewport, plus virtuoso hardening on 4 sibling flows). set-attributes-edit now PASSES locally (verified). CI re-run IN FLIGHT (bg poll byyh31y3k).
- AUDIT (owner asked "are the failures places needing the class?"): only #48's set-attributes-edit was the targeting bug (fixed). variant-metadata-editor (nav assert), team-picker (delete-confirm dialog), card-features-missing (parallelism) were NOT targeting — pass at parallelism=1; CI fails them under parallelism=3 contention. LATENT multi-input components still lacking the class (NEO-44): CardForm, ReconciliationModal, AttachSetsDialog, UnknownEntitiesDialog, VariantMetadataEditor. Owner: LEAVE them for now.
- **CONTINGENCY (owner's call):** if #48's CI re-run FAILS, combine #48 + #49 + roll in NEO-44 into ONE consolidation PR to fix the whole wrong-field-targeting class at once (add useFieldTestClass to all remaining multi-input forms; adopt the primitive). Don't do this unless #48 fails.
- Residual risk on #48: parallelism=3 flakes (team-picker not hardened) may still red it even though the deterministic failure is fixed.
