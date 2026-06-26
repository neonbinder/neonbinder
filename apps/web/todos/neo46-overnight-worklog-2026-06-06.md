# NEO-46 Overnight Worklog — 2026-06-06 (night)

Branch: `jburich/neo-46-scale-out-e2e-regression-across-multiple-free-runners-matrix`
PR: #51 (DO NOT MERGE — for CI validation only)

Mission (from user, heading to bed):
1. Iterate through ALL flow groups; dedup with judgment, **prioritizing full product-feature coverage**.
2. Keep this worklog (user will revisit item-by-item in the morning).
3. Push to the PR (don't merge); **iterate to green in CI** (local laptop JVM is crash-prone tonight — CI runners are clean and are the authoritative green signal).
4. Once CI is green, stay on this branch and **increase sharding parallelism** to find the fastest stable config.
5. Debug with chrome / gcloud / posthog. **No guessing — forensics first.**

Guiding principle for dedup: keep the flow(s) that best assert a PRODUCT FEATURE; delete flows that only re-assert an internal mechanism already covered elsewhere (e.g. the variant-agnostic `isCustomSubtree` fetch gate). When in doubt, keep coverage.

---

## Conventions applied to every converted flow
- Drop `requires:setup-done` / `requires:cards-loaded` (no dep-graph) → independent model.
- url: `${APP_URL}/testing/sign-in?redirect=/set-selector&worker=${WORKER_INDEX || "0"}`.
- Replace `extendedWaitUntil: visible/notVisible {timeout: N}` → plain `assertVisible` / `assertNotVisible` (7s default). Keep `scrollUntilVisible` (20s default). Long waits live ONLY in the setup track + the cold-sync portions of the drill utils.
- Maestro selector rules: visible text or `id:` (aria-label); search-result rows via `below:{id:"Search <entity>"}` not `index:`.

---

## DONE (committed)

### Earlier tonight (pre-handoff)
- `6e73804` sets-base → 2024 Topps Heritage (BaseSetPicker). Investigated via Convex data that "Topps Fire" is not a 2024 set. Validated green (fresh).
- `3913b1f` custom-insert/parallel cluster 6→3 feature-first. **Deleted** cards-insert-custom, cards-parallel-of-insert-custom, cards-custom-subtree-gate (gate-only/dup). **Refocused** cards-parallel-custom → asserts add-parallel FEATURE (entry appears + Custom badge + selectable). **Fixed** util-drill-to-custom-set Variant Types idle wait (non-scrolling) → killed a 30s CDP-scroll flake. All green first-attempt (fresh).
- `780b268` move-parallels-of-inserts-custom → independent + 7s. Green (fresh).
- `5d67c81` variant-metadata-editor-insert → independent + 7s. Green (fresh).
- `ca0ddb3` agent-memory: CDP-scroll flake class + Custom-badge assertion.

### parallel-grouping cluster (5 → 3)  [committing now]
- **Deleted** `parallel-grouping-accept-and-save` (duplicate of move-parallels: add-3→accept→save→Stars-top-level, identical final asserts).
- **Deleted** `parallel-grouping-keyboard` (only unique bit was backdrop-close; can't test real keyboard in Maestro web; folded backdrop-close into cancel-discards).
- **Converted + validated GREEN (fresh):** `parallel-grouping-cancel-discards` (+ folded backdrop-close as the 2nd close mechanism), `parallel-grouping-reject-parallel`.
- `parallel-grouping-suggestions`: converted; logic identical to cancel/reject. Surfaced + FIXED two real bugs below; local JVM SIGSEGV on the retry blocked a clean local pass — **deferring its green confirmation to CI**.

### Two real product/util bugs fixed (forensics, not retries)
- `util-drill-to-custom-set` set-selection used `index:1` in the >8-items search branch → unreliable (input/row order). Fixed to `below:{id:"Search sets"}`.
- **PRODUCT CODE** `components/SetSelector/EntitySelector.tsx`: every column's search `<input>` shared one className, so Maestro web `inputText` (class-based XPath) typed into the FIRST search box on the page (Sports) instead of the tapped one (Sets) whenever two columns both had >8 items. Added a unique per-column class `mb-search-<slug>`. Forensic proof: failure screenshot showed `pg-suggestions-0` typed into Sports → "No matches found". After fix, Maestro log shows the Sets row found `Below id: Search sets COMPLETED` + tapped. This fixes a whole CLASS of multi-column search flake.

---

## IN PROGRESS / TODO (set-selector remaining)
- checklist-* dialog cluster ×4 (cancel-dialog, unknown-entities-skip-some, keyboard-only-dialog, renders-rich-fields)
- SetAttributes cluster (set-attributes-edit, features-propagation, card-features-missing, tcdb-auto-enrich, topps-chrome-add-feature, topps-chrome-marketplace-read)
- card CRUD (card-detail-panel, edit-and-delete-card, team-picker, add-custom-card-to-checklist)
- multi-source-panel-opens-dialog
- custom-entry-survives-resync, custom-field-known-value-selects
- set-selector-smoke
- WIP ×5 (card-checklist-sync, custom-entry, empty-state, full-hierarchy-drill-down, refresh-sportlots-creds) — fix-or-delete each
- admin-missing-{both,bsc,sl}-shows-warning ×3 (credential gate) — verify timeouts
- 4 credential flows (test-/clear- bsc/sl)

## THEN
- Other groups (auth/dashboard/home/profile already trimmed earlier in NEO-46).
- Push PR → iterate CI green.
- Increase sharding parallelism; measure wall-clock.

## NOTES / OPEN ITEMS for morning review
- Local JVM (openjdk@21) crashed twice tonight (SIGABRT in bootstrap, SIGSEGV in suggestions) with 93% free memory — infra instability, NOT test bugs. CI is the green authority.
- `suggestions` needs a CI green tick to fully close the parallel-grouping cluster.
