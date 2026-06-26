# Overnight consolidation → green (2026-06-03 → 06-04)

Owner went to bed ~end of 06-03. Mandate: **merge the open PRs (#48 NEO-40 reactive-form, #49 NEO-45
targeting) into ONE branch, roll in NEO-44 (adopt useFieldTestClass on remaining multi-input forms),
and get the full CI e2e suite GREEN at parallelism=3.** 8 hours to iterate. "Do not give up, keep a
log of decisions." HOLD the actual merge-to-main for the owner.

## Hard rules (must follow)
- **Per-worker data isolation** (the root fix for parallelism=3 contention): every editing flow uses a
  PER-WORKER CUSTOM set under Baseball/2024; only 2 flows touch real 2024 Topps Chrome
  (topps-chrome-marketplace-read [read], topps-chrome-add-feature [write]), both tagged `isolated`.
  Encoded in maestro-e2e-author memory + definition.
- **NEVER run maestro directly — use `npm run test:e2e:pick -- <flow>`** (headless = CI's 1024×629
  viewport). Bare `maestro test` is non-headless and hides CI fold gotchas.
- Branch off LATEST main. Delegate flow authoring to maestro-e2e-author. No `wip` tags. Diagnose from
  real logs/screenshots, never speculation. tsc + security clean before final.
- 1024×629 viewport fold: a field at the bottom crashes tapOn→scrollToPoint; scroll a field BELOW the
  target into view to lift it off the fold (see set-attributes-edit "Value for Block" trick).

## The pieces being combined
- **#48** (jburich/neo-39-reactive-form-stability, NEO-40): ReactiveTextField uncontrolled primitive +
  migrate SetAttributesPanel/CardFeaturesEditor; useFieldTestClass in ReactiveTextField AND
  SetAttributesPanel rows; "Saved <field>" metadata toast; set-attributes-edit CI-viewport fix;
  Phase-1 data-isolation (set-attributes-edit→custom set + topps-chrome-marketplace-read/add-feature).
- **#49** (jburich/neo-45-maestro-inputtext-targeting, NEO-45): src/hooks/useFieldTestClass.ts +
  CardDetailPanel (6 fields) + CardChecklist add-form (4) + card-detail-panel.yaml fixes.
- **NEO-44**: add useFieldTestClass to CardForm, ReconciliationModal, AttachSetsDialog,
  UnknownEntitiesDialog, VariantMetadataEditor (the 5 remaining multi-input forms).
- **Phase 2 data-isolation**: card-detail-panel, team-picker, edit-and-delete-card, card-features-missing
  → per-worker custom sets (off shared Topps Chrome Base checklist).

## Root causes already fixed (context)
- Wrong-field targeting: maestro-web inputText re-finds focused el by createXPathFromElement (id→class→
  pos); shared className → non-unique XPath → types into FIRST input. Fix = unique mb-field-<id> class
  (useFieldTestClass). maestro#1083 closed not-planned.
- Parallelism=3 flakiness: selectorOptions/cardChecklist are GLOBAL; 3 workers editing same real set
  stomp/contend. Fix = per-worker custom sets.

## Log
- (start) Phase 1 committed on #48 (b323c80). Building consolidation branch off main next.

## Consolidation built + full collision audit (decision log)
- Branch `jburich/neo-40-45-44-consolidate` off origin/main. Merged #48 + #49 CLEANLY (no conflicts;
  shared useFieldTestClass.ts identical). tsc clean. 9 commits over main. Vite serving it on :3000.
- Phase 1 (set-attributes-edit→custom + topps-chrome-marketplace-read/add-feature) already on the branch
  via the #48 merge. ✓
- Phase 2 LAUNCHED (maestro-e2e-author bg): card-detail-panel, team-picker, edit-and-delete-card,
  card-features-missing → per-worker custom sets.
- AUDIT of remaining shared-Topps-Chrome WRITERS (collision sources still to fix):
  * features-propagation — edits real Topps Chrome "Value for League" at SET level (Step A) → MIGRATE to
    custom set + custom cards (Phase 3).
  * set-features-panel — edits real Topps Chrome "Value for League" → redundant w/ topps-chrome-add-feature;
    MIGRATE to custom (or fold) (Phase 3).
  * multi-source-panel-opens-dialog — mostly READS (asserts "Multi-source sets" panel) + idempotent
    "Confirm Base Set"; low risk → MONITOR, isolate only if it flakes.
  * tcdb-auto-enrich — triggers TCDB enrich (writes set metadata, idempotent-ish), asserts "Synced" →
    MONITOR; tag `isolated` if it flakes at p=3.
- PLAN ORDER: Phase 2 (running) → Phase 3 (features-propagation + set-features-panel → custom) → NEO-44
  (components) → push → CI(p=3) → iterate. Only ONE flow-testing agent at a time (shared Vite).
- NEO-44 analysis: real text-input collisions = CardForm (4 shared inputs), AttachSetsDialog (per-row
  edit-label inputs), UnknownEntitiesDialog (per-entity inputs). VariantMetadataEditor (1 text input =
  Prefix) + ReconciliationModal (distinct classes) likely no collision — add anyway for completeness/inert.

## 2026-06-04 MORNING — resumed after machine crash (owner survey → full-mandate execution)
Owner asked for a survey, then chose: KEEP & verify the interrupted Phase-3 WIP, and drive the FULL
mandate to green (push + PR), HOLD merge. State found at resume: consolidate branch had 10 commits +
uncommitted Phase-3 (features-propagation rewrite, set-features-panel deletion, set-attributes-edit
fold, topps-chrome-add-feature comment), NOT pushed, no PR. Nothing running (crash killed Vite/Maestro).

- ENV recovered: Vite up https://localhost:3000 (node 24.3.0), shared dev Convex focused-fox-53 reachable,
  gcloud ADC neonbinder@neonbinder.io. Branch has NO convex/ changes → Vite-only against shared dev (no
  local convex dev needed).
- COMMIT 58d9ada: Phase-3 flow isolation. Validated the 443-line features-propagation rewrite is valid
  YAML / not truncated before committing. Folded set-features-panel's unique "Will propagate to" assert
  into set-attributes-edit; deleted set-features-panel (redundant w/ topps-chrome-add-feature); README
  test-picker examples swapped off the deleted flow.
- COMMIT cf254f0: NEO-44 useFieldTestClass on CardForm (4 inputs), AttachSetsDialog (search + per-row
  edit-label keyed by platformValue), VariantMetadataEditor (Prefix), ReconciliationModal (FilterInput +
  per-item MetadataEditor Prefix). **UnknownEntitiesDialog SKIPPED** — evidence: its only inputs are
  include CHECKBOXES (no text inputs) → Maestro inputText has nothing to mis-target; the overnight
  "per-entity inputs" note was imprecise. tsc clean (only the 2 pre-existing errors).
- DIAGNOSIS of the 3 stubborn CI fails (from logs, no speculation): variant-metadata-editor-insert fails
  on `"Variant Types" is visible` which lives in util-drill-to-custom-set.yaml (shared drill), documented
  as p=3 shared-Convex render-contention — NOT targeting. cards-custom-subtree-gate = p=3-only (passed on
  #49). set-attributes-edit already carries its viewport+toast fix on the branch.
- LOCAL VERIFY (maestro-e2e-author, p=1, headless picker, java21): ALL 4 PASS first attempt, incl. the
  never-run features-propagation rewrite (clean). The 2 contention-suspect flows green at p=1 → confirms
  they are p=3-only. ZERO flow files changed by the agent.
- GATES: tsc clean; unit 135 passed/15 files. lint config ignores components/ (0 errors); lint not a CI gate.
- PUSHED branch (12 ahead, 0 behind origin/main). Opened **PR #50** (consolidates + supersedes #48/#49).
  pr-watcher running (bg). security-auditor running (bg) over the diff. CI e2e (p=3) in flight.
- HELD: merge. Pending: CI p=3 result (the real bar) → iterate on any true contention fails; security
  verdict; Linear NEO-40/44/45 updates; close #48/#49 after merge (owner's call).

## 2026-06-04 — CI p=3 RESULT on PR #50: 56 passed / 1 failed (huge improvement)
- security-auditor: APPROVED, zero findings (NEO-29 seed invariant holds; deps dev-only).
- CI e2e (run 26949017126, p=3, 44m): **56 passed, 1 failed.** The 2 contention-suspect flows
  (variant-metadata-editor-insert, cards-custom-subtree-gate) PASSED at p=3 → per-worker isolation WORKED.
  features-propagation + all NEO-44 forms passed.
- ONLY failure: **set-attributes-edit** Part C, Gate 1: `Assertion is false: ".*Saved Release Date.*"`.
  ROOT CAUSE (from downloaded maestro-report debug log + screenshot, NOT speculation):
  * Tap on `Value for Release Date` landed correctly (resource-id match, field text="—"/empty) → targeting OK.
  * eraseText took 3.5s, inputText "1900-01-01" landed IN the Release Date field (screenshot confirms the
    value is in the right field) → unique-class fix WORKS, no scramble.
  * After `pressKey: Enter`, the `.*Saved Release Date.*` optimistic toast NEVER appeared in 15s and the
    field was left FOCUSED + UNCOMMITTED at the sentinel. So the metadata save commit did not fire.
  * The "Saved <Field>" toast is emitted INSIDE handleSaveMetadata (the onSave) before its await; no toast
    ⇒ onSave never called ⇒ useReactiveField.runCommit either no-op'd or onKeyDown(Enter) never fired.
  * useReactiveField commits via onKeyDown(Enter) OR onBlur→runCommit (reads live DOM, no-ops if
    trimmed===baseline). Under p=3 CPU STARVATION the Enter→commit path did not trigger the save.
  * NOT a targeting regression, NOT introduced by NEO-44, and product works at human speed + at p=1 Maestro
    (verified). It is a p=3-CPU-starved maestro-web commit-trigger reliability issue on THIS one flow.
- PROPOSED FIX (flow-only, delegate to maestro-e2e-author): replace the fragile `pressKey: Enter` commit
  with a blur-commit (tapOn a neutral element) which routes through onBlur→runCommit reliably; keep the
  toast gate. Re-verify p=1, re-run CI p=3. Awaiting owner steer (product-vs-flow sensitivity on the
  central set-attributes-edit flow). Merge still HELD.

## 2026-06-04 — CI strategy decision (owner) + p=2 stopgap + NEO-46
- Owner reframed: "load of 3" is NOT product scalability — it's 3 headless Chrome + 3 JVMs on ONE free
  4-vCPU public runner (ubuntu-latest) = CPU starvation. Production concurrency (100s of users) is a
  separate axis (own client CPUs + Convex backend scaling). Corrected my earlier wording.
- Cost facts (researched): public repo ⇒ standard 4-core runner is FREE/unlimited; GitHub LARGER runners
  are billed even on public repos + need Team/Enterprise (Jan-2026 Linux: 8-core $0.022/min, 16-core
  $0.042/min). Full suite × every PR ⇒ ~$150/mo on 8-core. Owner: $80+/mo too much now.
- Constraint: prod-on-every-merge ⇒ FULL regression is the per-PR gate; smoke-only is NOT acceptable, so
  scope-cutting cadence levers are out. Answer = run the full suite faster/cheaper on FREE infra.
- DECISION (owner): (1) get #50 green now via lower parallelism (OK with p=2 or p=1); (2) cancel-in-progress;
  (3) file Linear for scale-out, tackle next.
  * cancel-in-progress: ALREADY present in e2e-tests.yml (per-PR group, cancel-in-progress: true). No change.
  * p=1 NOT viable: serial ≈90 min > job timeout. Chose **p=2** (2 browsers/4 cores = no starvation).
  * Committed a1ef490 on #50: MAESTRO_PARALLELISM 3→2 + timeout 60→75 (fewer workers lengthen wall-clock).
    Pushed; CI re-running at p=2 (expected GREEN — only set-attributes-edit failed at p=3, from starvation;
    other 56 already green at p=3). pr-watcher relaunched (bg).
- **NEO-46** filed (High, Backlog): scale OUT the regression suite across multiple FREE 4-core runners
  (matrix shards, globally-unique WORKER_INDEX, one seeded Convex preview, isolated marketplace lane on
  shard 0) → full suite, ~18-22 min, $0 compute. Spike third-party OSS-free runners (Blacksmith/Ubicloud/
  Depot) first as a lower-effort drop-in. https://linear.app/neonbinder/issue/NEO-46
- STILL HELD: merge of #50. Pending: p=2 CI result; Linear NEO-40/44/45 updates; close #48/#49 after merge.

## 2026-06-04 — p=2 made it WORSE (7 fails); root cause = non-deterministic drill/auto-sync flakiness
- p=2 CI (run 26957222170, 53m52s, did NOT hit 75m timeout): **49 passed, 7 failed** (was 56/1 at p=3).
  setup.yaml PASSED (DB reset+seed OK). Failures: set-attributes-edit + variant-metadata-editor-insert
  (w0); cards-custom-subtree-gate, cards-parallel-of-insert-custom, move-parallels-of-inserts-custom,
  parallel-grouping-accept-and-save, parallel-grouping-cancel-discards (w1).
- EVIDENCE (downloaded move-parallels-of-inserts-custom debug): Sports column rendered, but `Baseball`
  (auto-sync idle-signal) didn't appear for 60s → fail; retry → Baseball in 5s but `Add custom Sports`
  (idle-mode button) never appeared; CDP threw repeated `Failed to execute JS` (MismatchedInputException
  "No content to map"). So: the column auto-sync doesn't SETTLE + headless Chrome/CDP chokes under TWO
  concurrent browsers on a freshly-reset shared backend. NON-deterministic — losers shuffle per run
  (p=3 lost set-attributes-edit only; p=2 lost a different 7). NOT CPU starvation, NOT #50's code.
- CONCLUSION: lowering parallelism won't make it reliably green — only ELIMINATING concurrency (p=1: one
  browser, one session) will. This is the structural shared-backend + concurrent-browser flakiness that
  NEO-46 (isolated per-shard backends) is meant to kill. p=1 is a temporary MASK to land #50.
- ACTION: launched maestro-e2e-author (bg) to verify the 7 failing flows PASS at p=1 locally BEFORE
  flipping CI to p=1 (hard rule: pass locally before pushing; p=2 surprised us, so verify). If all 7 green
  at p=1 → flip CI MAESTRO_PARALLELISM 2→1 + raise timeout ~120 (p=1 ≈ 90m). If any fail deterministically
  at p=1 → genuine flow bug to harden. WILL NOT merge red. Vite still up. Merge HELD.
- LOCAL p=1 VERIFY RESULT: **all 7 PASS first attempt** (cards-custom-subtree-gate, cards-parallel-of-
  insert-custom, move-parallels-of-inserts-custom, parallel-grouping-accept-and-save, parallel-grouping-
  cancel-discards, set-attributes-edit, variant-metadata-editor-insert). Confirms p=2 failures were
  concurrency-induced. NO flow edits. ORTHOGONAL finding: setup.yaml failed attempt 1 / passed retry —
  pre-existing cold-start intermittent (60s `assertVisible "Base"` timeout on cold Cloud Run marketplace
  fetch in util-drill-to-2024-topps-chrome.yaml; retry warms Convex cache → attempt 2 passes). Retry-
  absorbed, not blocking; candidate for NEO-47 (bump that 60s ceiling).
- COMMITTED 2abf0eb + pushed: MAESTRO_PARALLELISM 2→1 (fully serial), timeout 75→150 (~110m serial run).
  CI re-running at p=1 — expect GREEN (7 verified + the rest already passed at higher p). pr-watcher
  relaunched (bg, paced for ~110m). Merge HELD.
- STRATEGY (owner thread): NEO-46 = scale OUT across free runners + isolated per-PR/per-shard backends
  (the durable fix; spike third-party OSS-free runners first). NEO-47 = harden flake WITHIN Maestro
  (isolation + seed drill state directly instead of driving slow auto-sync + driver stability) — KEEP
  Maestro (PO-readable YAML + mobile returning; Playwright = TS/web-only = net-negative here). Mobile is
  PAUSED not dead. p=1 is a ~110m stopgap gate until NEO-46/47 land.

## 2026-06-04 — p=1 CI FAILED too (7) — ROOT CAUSE WAS NEVER PARALLELISM (it's marketplace creds)
- p=1 CI (run 26962534337, 1h38m, did NOT timeout): **FAILED, 7 flows**: 6 on `No visible element: Add
  custom Years` (custom Football/2026 drill) + set-attributes-edit (`Saved Release Date`).
- SCREENSHOT (move-parallels-of-inserts-custom) is decisive: Years column = "No years available. Sync
  from marketplaces to populate." + dialog "Syncing Year Options — **No year options returned from any
  platform. Check that credentials are configured for BSC and SportLots.**" The repeated `CdpWebDriver:
  Failed to execute JS` was Maestro choking on the open error MODAL, a symptom not the cause.
- TRUE ROOT CAUSE: **marketplace credential / browser-service failure in CI** — BSC/SL sync returns EMPTY
  on the CI backend, so custom-drill columns never reach idle ("Add custom X" never appears). Parallelism
  was a RED HERRING: different flows fail each run because whichever needs a live marketplace sync when the
  browser service is cold/erroring loses. Local p=1 passed (warm dev browser service + working creds);
  CI p=1 failed (preview credential/sync path empty). Ties to known playbook: stale Cloud Run revision
  401s Convex /credentials (reference_e2e_bootstrap_coldstart_401) + PostHog credential_test_failed.
- I WAS WRONG to chase parallelism (p3→p2→p1). No MAESTRO_PARALLELISM value fixes an empty marketplace
  sync. p=1 workflow change is harmless-but-slow; revisit after the credential issue is fixed.
- NEXT (credential/browser-service playbook): (1) PostHog credential_test_failed for this window; (2) dev
  browser service Cloud Run neonbinder-browser@neonbinder-dev serving-revision/traffic + cold-start; (3)
  confirm preview NEONBINDER_BROWSER_URL + server-side seedMyTestCredentials reach a working service.
  Strongly reinforces NEO-47 "seed drill state directly" (don't depend on live marketplace sync). Merge HELD.

## 2026-06-04 — TRUE ROOT CAUSE FOUND (not infra, not parallelism, not creds): YearForm blocking dialog
- Reverted CI to p=3 + timeout 60 (commit cdbbfe2, HELD unpushed — don't burn CI until fixed).
- BROWSER SERVICE IS HEALTHY (gcloud logs, neonbinder-dev): revision 00099-men serves 100% and
  successfully auths BOTH BSC + SportLots (cached tokens valid, fresh SL login success at 16:47) right
  through the CI window 16:14-16:18. The 401s are on 00101-niq (0% traffic) = Cloud Run IAM invoker errors
  (tag-URL probes), unrelated. CREDS NOT BROKEN — the app's "check credentials" text is a misleading
  generic empty-result message. (Side note: 00101-niq=pr-43 image sits ready at 0%; traffic pinned to
  00099-men — a pre-existing pin, harmless here.)
- ROOT CAUSE (YearForm.tsx + util-drill-to-custom-set.yaml): drilling into a sport auto-fires
  fetchAggregatedOptions (YearForm useEffect). On empty result it sets success=false and shows a BLOCKING
  dialog "No year options returned from any platform. Check that credentials are configured for BSC and
  SportLots" with a Close button + onDone NOT called → column never reaches idle, "Add custom Years"
  stays hidden behind the dialog. The drill flow does NOT click Close — it goes straight to
  scrollUntilVisible "Add custom Years" → 60s timeout → FAIL.
- WHY CI fails / local passes: CI's per-PR PREVIEW backend is FRESH → custom Football/2026 doesn't exist →
  YearForm fires → empty → dialog. LOCAL focused-fox-53 had Football/2026 from earlier runs → no sync →
  idle directly. Explains the shuffle (whichever flow hit fresh Football first lost) across p3/p2/p1.
- #50 AMPLIFIED exposure: the per-worker-custom-set isolation moved more flows onto the custom Football/
  2026 drill (util-drill-to-custom-set), which is the flaky path. Pre-existing app/flow bug, surfaced by #50.
- FIX OPTIONS: (A) APP — YearForm/custom-subtree should short-circuit GRACEFULLY on empty for a custom
  sport (call onDone → idle, no blocking "check credentials" dialog). Fixes real UX (custom set creators
  shouldn't see a creds error) + the flake. (B) FLOW — dismiss the YearForm dialog (tapOn Close) before
  seeking "Add custom Years". A is the root fix; B is a band-aid. Likely A (+B as belt-and-suspenders).
  This is NEO-47 territory. Awaiting owner steer. Merge HELD; p=3 revert committed-not-pushed.

## 2026-06-04 — FIX IMPLEMENTED (owner chose App fix) + p=3 restored
- Owner: App fix (graceful short-circuit) + get back to p=3. Done both.
- CONFIRMED mechanism: EntityColumn auto-opens the sync form (renderForm) when a column is empty
  (autoSyncedRef guards re-fire); the *Form auto-fires fetchAggregatedOptions on mount; on empty it
  only called onDone on success → left a BLOCKING dialog hiding the idle "+ Custom" (Add custom X) button.
  The custom-subtree gate (isCustomSubtree → success:true) did NOT fire because the failing case is a
  custom CHILD under a MARKETPLACE-created parent (Football exists as marketplace sport, isCustom=false),
  so the year fetch hit BSC/SL → empty → line-2584 "No options returned… check credentials". autoSyncedRef
  means onDone→idle does NOT re-loop.
- FIX (commit dc32ec6): all 5 drill forms (Sport/Year/Manufacturer/SetVariant via fetchAggregatedOptions
  → optionsCount===0; Set via syncSets → totalSets===0) now ALSO go idle on an empty result, not just on
  success → "+ Custom" reachable. Thrown exceptions still show error+Retry. tsc clean (4 pre-existing).
  Real UX win too (custom-set creators no longer see a misleading creds error).
- Reverted CI to p=3 + timeout 60 (cdbbfe2). Verification: empty-sync condition doesn't repro locally
  (local backend returns data / Football pre-exists), so a deterministic COMPONENT TEST is the local gate —
  delegated to unit-test-author (bg). Will commit test + push fix+test together (cancel-in-progress would
  waste a run if pushed separately) → CI p=3 → pr-watcher.
- REMAINING after this fix: set-attributes-edit "Saved Release Date" is a SEPARATE issue (drills the seeded
  Baseball/2024 path, reaches Part C, then the metadata save toast doesn't appear). Was the lone p=3
  failure originally. If it persists, diagnose separately. Merge HELD.
