# 🌅 START HERE — Maestro Flow Quality Audit (all 57 flows vs the 8 rules)

*Generated 2026-06-08 ~9 PM CDT (overnight, NEO-49 branch `jburich/neo-49-e2e-dynamic-queue`). Reviewed by 6 parallel maestro-e2e-author agents. This is the morning starting point.*

## How to use this
Every flow was judged against our **8 flow-quality rules**:
1. What product feature are we validating?
2. Do we assert that, and **only** that?
3. Are there other tests covering this same feature? (dedup)
4. Assume setup + Phase-0 bootstrap ran (signed in, creds seeded, BSC+SL warmed) — is it independent given that? **Stop re-logging-in.**
5. Any extra `extendedWaitUntil` timeouts? Remove them (7s default unless a real backend round-trip).
6. Do the scrolls/visibility checks match reality, or are we cluttered?
7. No destructive data actions.
8. Anything we click has `centerElement: true` on the scroll to it.

Each flow below lists **Feature (rule 1)** + **Flags** (rules 2–8 issues with the fix), or "✅ Meets all 8 rules." **All edits go through the `maestro-e2e-author` agent.**

---

## Executive summary
**57 flows reviewed · ~16 clean · ~41 with at least one flag.** The flags cluster into a handful of **mechanical sweeps** (high-volume, low-risk) plus a short list of **real correctness bugs** to do first.

### 🔴 Correctness — do these first (real bugs, not cleanup)
1. **`set-selector/refresh-sportlots-creds.yaml` (R7 destructive + R6 bug + tag):** clears SL credentials and saves **fake** ones with **no restore** → any later flow on that worker that needs a live SL token breaks. Also uses `optional: true` on a `scrollUntilVisible` (not a valid web-driver property → silent no-op/parse risk; use a `when:` guard). Also mis-tagged `set-selector` (it's a `profile`/credentials flow).
2. **`util/util-login-to-bsc.yaml` + `util/util-login-to-sportlots.yaml` (R8 — real CDP-scroll flake source):** the `scrollUntilVisible` to "Test Credentials" / the SL-auth-success toast on the below-the-fold creds page **omits `centerElement: true`** — the exact CDP-scroll flake (`MismatchedInputException`) that failed `sets-base`. Fix at the util source to harden the warm. Also drop the 20s "Neon Binder" wait (R5) and the redundant `assertVisible` after the toast scroll (R6). *(On tonight's seed this util flaked but RECOVERED — it was NOT the seed failure; see "Live signal".)*
3. **Silent `when:` fall-throughs (R2)** — flows that can go **green without testing their feature**: `checklist-fetch-cancel-dialog` (skips if the dialog never opens), `home/ai-identification`, `home/collection-tracking`, `home/managing-inventory` (Get-Started branch skipped when signed in), `profile/setup-bsc-credentials` + `setup-sportlots-credentials` (no post-branch guard that creds exist). Add an explicit precondition assert before/after each branch.
4. **Shared-set WRITES under the queue model (R4/isolation):** `topps-chrome-add-feature` (the one sanctioned write), `topps-chrome-marketplace-read`, `tcdb-auto-enrich`, `multi-source-panel-opens-dialog` (taps "Confirm Base Set" = a write) all reference an `isolated` tag in comments that **isn't in their `tags:` block**. ⚠️ **Architectural note:** the NEO-49 queue **removed lanes** — every flow runs independently on whatever runner claims it, so the old `isolated`/serial-lane concept no longer exists. Decide the new isolation story for shared-set writers (per-worker subtree, idempotent-write tolerance, or a dedicated serialized step) rather than just re-adding a dead tag.

### 🟡 Mechanical sweeps (do as batch edits — appear in almost every flow)
- **R6 — redundant `assertVisible` right after `scrollUntilVisible` for the same element.** The single most common flag (~20+ flows). `scrollUntilVisible` already asserts visibility; drop the trailing `assertVisible`.
- **R8 — missing `centerElement: true`** before scroll-to-tap targets (footer-steal at the 1024×629 headless viewport). Many flows.
- **R5 — inflated `extendedWaitUntil timeout:` on pure-UI waits** (column-render 20–60s, "Neon Binder"/"Set Selector" 45s). Drop the `timeout:` → 7s default. **Keep** only genuine backend round-trips: marketplace fetch ~60s, TCDB ~90s, credential clear/seed ~120s, cold sign-in.

### 🟢 Dedup candidates (R3 — propose before deleting)
- `profile`: the credential flows overlap heavily — `save-`/`setup-`/`clear-then-setup-`/`test-` × {bsc, sl} all re-exercise the Clear-Credentials lifecycle. Consolidation candidate.
- `profile/edit-profile.yaml`: only asserts the form renders; `fill-profile-data.yaml` already covers it fully → delete or make it a real minimal edit smoke.
- `set-selector/admin-missing-{both,bsc,sl}`: near-identical triplet (each a distinct gate condition — keep, but parametrize-able).
- `home/landing-smoke` vs `landing-marketing`: overlapping "Neon Binder" assertion.

---

## 🏷️ Tag hygiene (per the "no WIP or other tags should remain" note)
- **WIP comments to remove:** `setup.yaml` and `set-selector/custom-entry-survives-resync.yaml` both carry `# WIP:` block comments. (No actual `- wip` **tags** exist in any `tags:` block ✅ — these are comments, but they describe known-broken paths and must be resolved or removed, not shipped.) `custom-entry-survives-resync`'s WIP comment describes an unreliable `inputText`→React-onChange path the flow still depends on — fix or remove.
- **Tag inconsistencies to reconcile:**
  - `home/collection-tracking.yaml` — tagged only `marketing`, missing `home` (excluded from `home`-tag runs). The other 3 home flows have `home`.
  - `set-selector/refresh-sportlots-creds.yaml` — tagged `set-selector` but it's a profile/credentials flow.
  - `topps-chrome-add-feature` / `topps-chrome-marketplace-read` / `tcdb-auto-enrich` / `multi-source-panel-opens-dialog` — "(isolated)" in name/comments, no matching tag (see R4 architectural note above — likely obsolete under the queue, confirm + remove the misleading comments).

## ⚠️ Live signal from tonight (CORRECTED — read carefully)
The `sets-base` fix (PR #52, commit `fdf0271`) is **not yet validated** — the queue re-run **failed at the seed**, not the runners. **Forensic cause (log line 1702):** in `setup.yaml`, `tapOn "Base"` → `Select Base Set` appeared (Path A) → but **`Confirm Base Set` never rendered within 45s** → assertion failed. The `util-login-to-sportlots` warm flaked once (`MismatchedInputException`) but **RECOVERED and COMPLETED** — it was NOT the cause, and `centerElement` will NOT fix this. The real cause is a **marketplace-fetch problem**: the live SportLots base-set fetch for 2024 Topps Chrome returned **no confirmable "likely match"**, so the picker opened with nothing to confirm. **Action:** diagnose the SL base-set fetch (PostHog `adapter_sync_call` for this run / replicate the SL request) — confirm it's a transient SL fetch vs. a real SL data gap for Topps Chrome. Separately, consider making `setup.yaml`'s BaseSetPicker block handle the "picker open, no match" case (it currently assumes Path A always yields a Confirm button). Then re-run to validate `setup.yaml` + `sets-base`.

---

## Per-flow findings

> Verbatim from the 6 reviewers. `R<n>` = rule number.

#### Group: set-selector A — 11 flows, 7 with flags

### set-selector/admin-missing-both-shows-warning.yaml
**Feature:** Credentials gate on /set-selector shows a banner naming BOTH BSC and SportLots when both creds are absent; CTA link navigates to /profile.
**Flags:**
- R6: `scrollUntilVisible ".*Sportlots Credentials.*"` (no centerElement, never tapped) is immediately followed by `scrollUntilVisible "Clear Credentials" centerElement:true` → remove the intermediate scroll.
- R5: the `"Credentials cleared"`/`"Profile Settings"` 30s waits are genuine backend round-trips — keep. All taps are `centerElement`-guarded ✅.

### set-selector/admin-missing-bsc-shows-warning.yaml
**Feature:** Gate shows a BSC-only banner when BSC creds absent + SL present.
**Flags:**
- R6: redundant intermediate `scrollUntilVisible "BuySportsCards Credentials"` before the `"Clear Credentials"` scroll → remove.
- R3: structural near-duplicate of the other two admin-missing flows (distinct gate conditions — keep; note for a future parametrized refactor).

### set-selector/admin-missing-sl-shows-warning.yaml
**Feature:** Gate shows an SL-only banner when SL creds absent + BSC present.
**Flags:**
- R6: redundant intermediate `scrollUntilVisible ".*Sportlots Credentials.*"` → remove.
- R3: same triplet note.

### set-selector/card-detail-panel.yaml
**Feature:** Card detail drawer — open, edit name/title/description/RC chip, dirty-guard (backdrop + × → confirm bar, "Keep editing" dismisses), save persists, Cancel closes.
**Flags:**
- R6: `scrollUntilVisible id:"Toggle RC" centerElement` → `assertVisible id:"Toggle RC"` (lines 213–219) redundant → drop the assert. Same pair at lines 337–344 → drop.
- R8: Save/Cancel taps use `assertVisible` instead of scroll (position:fixed sticky footer — `scrollUntilVisible` would time out). Documented + correct. Accepted.

### set-selector/card-features-missing.yaml
**Feature:** A freshly-added custom card with no feature values shows the amber "Missing required feature" warning when the editor is expanded.
**Flags:**
- R6: redundant `assertVisible` after scroll at line 107 and lines 120–121 → drop both.
- R8: `tapOn id:"Cancel card edit"` (line 161) has no `assertVisible` guard (unlike card-detail-panel's sticky-footer pattern) → add `assertVisible id:"Cancel card edit"` before the tap.

### set-selector/cards-parallel-custom.yaml
**Feature:** Add a custom Parallel entry to a set's Parallel variant type; new entry shows a "Custom" badge and is selectable (opens empty CardChecklist).
**Flags:**
- R6: redundant `assertVisible ".*Fetch from Marketplaces.*|Refresh"` after its scroll (lines 74–75) → drop.
- R8: `tapOn ".*Prizm Gold.*"` (line 69) has no preceding centered scroll → add `scrollUntilVisible … centerElement:true`.

### set-selector/checklist-fetch-cancel-dialog.yaml
**Feature:** Cancelling the UnknownEntitiesDialog aborts the commit — no cards saved, "Fetch cancelled — no cards saved." shows, Fetch button remains.
**Flags:**
- R2: the `when: visible:"Confirm New Players & Teams"` branch silently skips if the dialog never opens → the cancel behavior (the whole point) goes untested → add `assertVisible "Confirm New Players & Teams"` BEFORE the branch.
- R4: the "FRESH-DB REQUIREMENT / manual Reset Set Builder Data" comment is misleading given the custom-card preamble → update/remove the comment.
- R5: several `extendedWaitUntil … timeout:5000` (sub-7s) on UI waits → remove the explicit timeouts.
- R6: `scrollUntilVisible id:"Sync card checklist"` then `extendedWaitUntil visible: id:"Sync card checklist" timeout:5000` (lines 173–182) → drop the extendedWaitUntil.

### set-selector/checklist-fetch-unknown-entities-skip-some.yaml
**Feature:** Unchecking individual unknown players before confirm — skipped names aren't created, all cards still save.
**Flags:**
- R2: `tapOn point:"25%, 38%"` to uncheck the first player has no anchoring assert at that location → add `assertVisible ".*USPlayerA-${TEST_USERNAME}.*"` before the point tap.
- R5: `extendedWaitUntil … timeout:5000` (sub-7s) on UI waits → remove. (The 30s waits after Confirm are real backend writes — keep.)
- R8: `tapOn ".*Confirm … & Save.*"` (modal footer) → add an `assertVisible` before it.

### set-selector/checklist-keyboard-only-dialog.yaml
**Feature:** UnknownEntitiesDialog confirm button is auto-focused; Enter fires confirm and saves all cards with no mouse.
**Flags:**
- R5: several sub-7s explicit timeouts (`5000`, the `10000` auto-focus wait) → remove → 7s default. (The 60s "Saved N cards" wait for 300+ cards is justified — keep.)

### set-selector/checklist-renders-rich-fields.yaml
**Feature:** After a fetch, each card row renders #NNN card number, BSC platform badge, and RC badge.
**Flags:**
- R8: `tapOn ".*Fetch from Marketplaces.*|Refresh"` (line 60) has no preceding centered scroll in THIS flow → add `scrollUntilVisible … centerElement:true` (or at least an assertVisible).
- R6: redundant `assertVisible "RC"` after its scroll (line 111) → drop.
- R5: `scrollUntilVisible "RC" timeout:30000` is a UI scroll, not a backend wait → reduce to ~10–15s or remove the timeout.

### set-selector/custom-card-crud.yaml
**Feature:** Custom card lifecycle — add (#num + name + "Custom" badge), rename (sticks; old gone), delete (two-step confirm removes row).
**Flags:**
- R6: redundant `assertVisible "Renamed ${ATTEMPT_ID}"` after its scroll (line 100) → drop.
- R4/R7 ✅ — per-worker subtree (`ccrud-${WORKER_INDEX}`), no re-login, no global reset.

#### Group: set-selector B — 11 flows, 9 with flags

### set-selector/sets-base.yaml
**Feature:** BaseSetPicker — live SL base-set fetch, picker structure, confirm, CardChecklist render after mapping.
**Flags:** ✅ Meets all 8 rules. (The reference exemplar — just rewritten. 60s wait justified; both `when:` branches end in explicit asserts; Topps Heritage isolates from setup's Topps Chrome; centerElement throughout; no redundant asserts.)

### set-selector/set-selector-smoke.yaml
**Feature:** Sports column sync — syncs sports from marketplaces, verifies "Baseball" appears.
**Flags:**
- R2/R4: re-runs `setup-bsc-credentials` + `setup-sportlots-credentials` (Phase-0 already did) → remove; extra failure surface even when idempotent.
- R5: `"Neon Binder" timeout:45000`, `"Set Selector" timeout:15000`, `timeout:10000` are pure-UI → 7s default. (60s on "Sync Sports" is the live response — keep.)
- R6: `extendedWaitUntil "Sync Sports" timeout:5000` then `assertVisible "Sync Sports"` → drop the assert.
- R8: `tapOn "Sync Sports"` scroll omits `centerElement` (documented CDP edge-button exception — make the comment cite the rule so it isn't re-flagged).

### set-selector/custom-entry-survives-resync.yaml
**Feature:** Custom sport entry persists through a marketplace re-sync (custom badge still visible; marketplace entries present).
**Flags:**
- **WIP:** lines 6–17 are a `# WIP:` block describing an unreliable `inputText`→React-onChange path the flow depends on (lines 107–108) → fix or remove (no WIP comments remain).
- R2: if the search filter silently fails to trigger, `assertVisible "TestCustomSport-${TEST_USERNAME}"` may pass on a stale DOM match.
- R4: re-runs both `setup-bsc/sportlots-credentials` (~30s + 2 failure surfaces) → remove; rely on bootstrap.
- R5: `"Set Selector" timeout:45000`, `"+ Custom" timeout:10000` pure-UI → default. (60s post-sync "Sync Sports" is the round-trip — keep.)

### set-selector/custom-field-known-value-selects.yaml
**Feature:** Typing a known synced value ("Baseball") into "+ Custom" selects the existing row (no duplicate) and advances to Years.
**Flags:**
- R5: many inflated UI timeouts (`"Set Selector" 45000`+`20000`, `"Sports" 30000`, `"Baseball" 60000`, `"Add Custom Entry" 5000`, `"Years" 30000`, `scroll 60000`) → 7s default unless a cold sync genuinely fires.
- R2: double-navigate (launchApp lands on /set-selector, then `openLink /set-selector` again) → one navigation suffices.
- R6: `extendedWaitUntil "Add Custom Entry" timeout:5000` adds no proof beyond the preceding tap → drop.

### set-selector/features-propagation.yaml
**Feature:** Full propagation lifecycle — set-level feature propagates to child cards; per-card override survives re-propagation; revert restores inheritance (per-worker custom set).
**Flags:**
- R5: `"Search years" 60000`, `"Search manufacturers" 30000`, `"Search sets" 60000` for UI column renders → 7s default unless a marketplace sync fires.
- R6: redundant `assertVisible` after `scrollUntilVisible` for the same player element at lines 337–343, 409–413, 558–562 → drop each.
- R8: `tapOn "Insert"` (line 282) scroll lacks `centerElement:true` → add (line 539's UP scroll already has it).
- R2: Step D re-drills the whole path inline (~55 lines) — necessary after reload, noted as maintenance burden.

### set-selector/move-parallels-of-inserts-custom.yaml
**Feature:** Group Parallels modal — auto-suggestion pre-placement, Accept All clears badges, Save persists nesting; Inserts column reflects promoted parallels.
**Flags:**
- R6: `scrollUntilVisible "Stars Gold"` then `assertVisible "Stars Gold"` (line 153) redundant → drop. ("Stars Red" assert relies on same viewport — clip risk at 1024×629.)
- R8: modal taps `".*Accept all suggestions.*"` (116) and `".*Save N change.*"` (125) lack dedicated centered scrolls → add `scrollUntilVisible … centerElement:true` before each.

### set-selector/multi-source-panel-opens-dialog.yaml
**Feature:** Multi-source sets panel visible; "Attach more…" opens the Attach dialog; typing narrows the BSC list; Cancel dismisses cleanly.
**Flags:**
- R3: the ~100-line Topps Chrome drill duplicates sets-base's drill → extract into `util-drill-to-2024-topps-chrome`.
- R4: taps "Confirm Base Set" = a **write** to the shared Topps Chrome set → concurrent-worker write contention risk (see queue isolation note) → defer/remove the confirm or isolate.
- R5: nearly every intermediate drill step has an inflated UI timeout (20–30s) → 7s default.
- R6: `extendedWaitUntil visible:"Baseball"` then `scrollUntilVisible "Baseball"` then tap — drop the extendedWaitUntil, keep the centered scroll (pattern repeats per level). `extendedWaitUntil "Confirm Base Set" timeout:60000` after the picker is open is excessive.

### set-selector/parallel-grouping-cancel-discards.yaml
**Feature:** Parallel Grouping modal Cancel discards pending changes (re-open shows "Suggested" badges); backdrop close also discards.
**Flags:**
- R8: `scrollUntilVisible "Group Parallels"` (lines 71, 127) lacks `centerElement:true` (footer-steal) → add to both.
- R6: `scrollUntilVisible "Suggested"` then `assertVisible "Suggested"` (line 137) → drop the assert.
- R5: `extendedWaitUntil "^Inserts$" timeout:5000` (sub-7s) → default.

### set-selector/parallel-grouping-reject-parallel.yaml
**Feature:** Reject (✕) moves a suggested parallel back to top-level inserts; net-zero diff disables Save + shows "No changes yet".
**Flags:**
- R8: `scrollUntilVisible "Group Parallels"` (line 68) lacks `centerElement:true` → add.
- R2: asserts both "No changes yet" and "No changes" — confirm these are distinct UI strings (else one is redundant).

### set-selector/set-attributes-edit.yaml
**Feature:** SetAttributesPanel — breadcrumb scope at setName level, metadata edit + toast, collapse/expand, child-scope breadcrumb after drilling to a variant type (per-worker custom set).
**Flags:**
- R5: `"Set Selector" 45000`, `"Search years" 60000`, `"Search manufacturers" 30000` pure-UI → default.
- R2: `when: visible id:"Edit attributes"` idempotent-expand branches are OK — the `assertVisible id:"Hide attributes"` after each is the hard guard ✅.

#### Group: set-selector C — 10 flows, 7 with flags

### set-selector/sets-resync-already-loaded.yaml
**Feature:** Variant types (Base/Insert/Parallel) persisted from setup are still visible on a fresh session; EntityColumn auto-sync guard suppresses a re-sync when items already exist (idle: "Sync Variant Types" visible, not in progress).
**Flags:**
- R6: `scrollUntilVisible "Sync Variant Types"` then `assertVisible "Sync Variant Types"` → drop the assert.
- R8: the Base/Insert/Parallel asserts (37–39) sit in an `overflow-y-auto` column, can be below fold → add `scrollUntilVisible "Base" centerElement:true` before the trio.

### set-selector/tcdb-auto-enrich.yaml
**Feature:** The fire-and-forget `enrichSetFromTcdb` job surfaces in SetAttributesPanel — TCDB chips ("Released"/"Cards"/"Block"/"TCDB SID") or the graceful "No set metadata yet — pending sync." fallback.
**Flags:**
- R2/R6: the `when: visible:"Released"` branch + the `extendedWaitUntil`+`assertVisible` on the same 90s pattern → drop the redundant assert (keep 90s as the TCDB SLA, comment it).
- R4/tag: comment says "isolated serial lane" but `isolated` tag is absent → reconcile (see queue note).
- R8: `tapOn "Baseball"`/`id:"Search sports"` has no centered scroll — Sports column pushed to ~y=556 (footer zone) by AdminTools → add `scrollUntilVisible id:"Search sports" centerElement:true` (it hand-rolls its drill instead of using the util).

### set-selector/team-picker.yaml
**Feature:** NEO-26 TeamPicker chip component on a per-worker custom card — add/remove chip, "No matches." empty state, Enter confirm, Cancel reverts, save+reload persistence.
**Flags:**
- R5: the reload re-drill copies the 60s "Search years" wait — but reload is warm, not cold → drop to default there.
- R6: line 207 `assertVisible "Base"` comes BEFORE `scrollUntilVisible "Base"` (line 208) — reversed; if below fold the assert fails first → swap to scroll-then-assert.
- R8: Tests 2–7 form-field taps (Add team / Search teams / Card name) assume in-place expansion within the centered card row — acceptable by context; add a justifying comment.

### set-selector/topps-chrome-add-feature.yaml
**Feature:** Writes "TChrome-MLB" to the "League" field of the REAL 2024 Topps Chrome set via SetAttributesPanel, verifies "Updated N cards" propagation toast, reloads + re-drills to confirm persistence.
**Flags:**
- **R4/tag (Critical under old model):** name/comments say "(isolated)"; `isolated` tag absent → this is the ONE sanctioned shared-set write → see queue isolation note (lanes are gone; pick a new strategy).
- R5: `"Years" 20000`, `"Manufacturers" 20000` column-heading waits → default. (search-input 30/60s sync waits — keep.)
- R6: `scrollUntilVisible id:"Value for League"` then `extendedWaitUntil visible id:"Value for League" timeout:5000` → drop the extendedWaitUntil.

### set-selector/topps-chrome-marketplace-read.yaml
**Feature:** Read-only — SetAttributesPanel on real 2024 Topps Chrome renders breadcrumb ancestry, "Will propagate to N cards" counter, ≥1 marketplace-derived feature row ("Value for League").
**Flags:**
- R4/tag: same `isolated`-in-comment-not-in-tags (read-only, lower risk) → reconcile.
- R5: same 20s column-heading inflation → default.
- R6: `scrollUntilVisible id:"Value for League"` then `assertVisible id:"Value for League"` → drop the assert.

### set-selector/util-drill-to-2024-topps-chrome.yaml
**Feature (drill state):** Baseball → 2024 → Topps → Topps Chrome via per-level search inputs; returns with Variant Types column visible + Base present. Shared entry point for cascade-data flows.
**Flags:**
- R6: `extendedWaitUntil visible:"Base" timeout:60000` then `assertVisible "Base"` (line 131) → drop the assert.

### set-selector/util-drill-to-base-variant.yaml
**Feature (drill state):** Extends the Topps-Chrome drill by selecting "Base", handling BaseSetPicker (Path A confirm / Path B auto-close), returns with CardChecklist visible.
**Flags:** ✅ Meets all 8 rules. (The scroll-then-assert near line 120–127 targets *different* elements — not a R6 violation. `when:` branches clean.)

### set-selector/util-drill-to-custom-set.yaml
**Feature (drill state):** Per-worker `E2E Test Sport N → 2026 → Topps → SET_NAME` subtree, creating missing levels as custom entries; returns with VARIANT_TYPE (default "Insert") selected + its Variants column open with "+ Custom".
**Flags:** ✅ Meets all 8 rules. (Sub-7s waits are inside conditional create-branches; scroll-then-tap pairs target distinct elements; per-level taps all centered.)

### set-selector/util-drill-to-insert-variants.yaml
**Feature (drill state):** Extends the Topps-Chrome drill by selecting "Insert", waits for VariantForm auto-sync (cancels ReconciliationModal if it appears), returns with Inserts column + "Group Parallels" present.
**Flags:**
- **Stale comment:** lines 25–29 claim "This util resets the DB" / "util-drill-to-2024-topps-chrome … includes the DB reset step" — NEITHER is true → remove the false DB-reset claim (misleads callers).
- R6: `scrollUntilVisible "Group Parallels"` then `assertVisible "Group Parallels"` (line 133) → drop the assert.

### set-selector/variant-metadata-editor-insert.yaml
**Feature:** Add a custom Insert ("META-TEST") in a per-worker set, open VariantMetadataEditor, edit Prefix to "TEST-", save, verify Save disappears + panel stays with Prefix intact.
**Flags:**
- R6: `scrollUntilVisible "Metadata"` then `assertVisible "Metadata"` (line 72) → drop the assert.
- R8: `tapOn "Prefix:"` (line 79) — last row in the panel, may be below fold even after centering "Metadata" → add `scrollUntilVisible "Prefix:" centerElement:true`.

#### Group: profile — 12 flows, 8 with flags

### profile/worker-bootstrap.yaml
**Feature:** Phase-0 infrastructure — per-worker sign in, reset Convex state, seed real BSC+SL creds, best-effort warm tokens.
**Flags:** ✅ Meets all 8 rules (infrastructure flow — 45s chain wait + optional warm runFlows are correct here).

### profile/view-profile.yaml
**Feature:** Profile page loads, shows "Profile Settings" + "Public Profile" headings.
**Flags:** ✅ Meets all 8 rules (clean smoke).

### profile/edit-profile.yaml
**Feature:** Public-profile edit form renders with "Basic Info" + a visible "Save Public Profile" button.
**Flags:**
- R1/R2: name promises an edit but only asserts the form renders → rename to a form-presence smoke OR make it a real edit-and-save.
- R3: `fill-profile-data.yaml` already covers this fully → delete or reduce to a minimal one-field-edit smoke.
- R6: `scrollUntilVisible "Save Public Profile"` then `assertVisible` → drop the assert.

### profile/fill-profile-data.yaml
**Feature:** Fill every public-profile field, save, verify all values render on `/u/TEST_USERNAME`.
**Flags:**
- R6: `scrollUntilVisible ".*x.com/…"` then `assertVisible` (155–157) → drop.
- R8: `assertVisible` for the instagram + tiktok links (158–160) are below the fold with no scroll → add `scrollUntilVisible … centerElement:true` before each.

### profile/save-bsc-credentials.yaml
**Feature:** BSC credential save lifecycle (fake creds) — save → "Credentials were saved" banner → clear → form resets → restore real creds.
**Flags:**
- R3: Clear-Credentials lifecycle overlaps `test-bsc-credentials` (note).
- R5: `"Neon Binder" timeout:45000` + `"Profile Settings" timeout:30000` are pure-UI (no reset chain here) → 7s default.
- R6: `scrollUntilVisible ".*Credentials were saved.*" timeout:120000` then `assertVisible` → drop the assert (keep 120s as the real BSC round-trip).

### profile/save-sportlots-credentials.yaml
**Feature:** SL credential save lifecycle (mirror of save-bsc on the Sportlots tab).
**Flags:** Same three as save-bsc: R3 overlap, R5 `"Neon Binder" 45000`, R6 redundant assert after the saved-banner scroll.

### profile/setup-bsc-credentials.yaml
**Feature:** Util — idempotently ensure BSC fake creds saved; precondition for downstream flows.
**Flags:**
- R2: latent false-pass — if the optional scroll fails to reveal an off-screen "Clear Credentials", the `when:` skips saving and exits with creds unguaranteed → add `assertVisible "Clear Credentials"` after the branches.
- R6: the first `scrollUntilVisible "Save Credentials"` (line 58) could instead target `id:"password"` to reflect its real purpose.

### profile/setup-sportlots-credentials.yaml
**Feature:** Util — idempotently ensure SL fake creds saved.
**Flags:**
- R2: the `when: visible "Clear Credentials"` branch contains only a meaningless `assertVisible ".*Sportlots.*"` (always-on tab text) → delete the dead branch or assert something real.
- R2: same post-branch guard gap as setup-bsc → add `assertVisible "Clear Credentials"`.

### profile/clear-then-setup-bsc-credentials.yaml
**Feature:** Destructive helper — unconditionally clear BSC creds, then save fake fresh; foundation for save-bsc/test-bsc.
**Flags:** ✅ Meets all 8 rules (the in-branch tap is safe — scroll directly above it; 120s wait is a real round-trip; minor: add a clarifying comment).

### profile/clear-then-setup-sportlots-credentials.yaml
**Feature:** Destructive helper — mirror of clear-then-setup-bsc on the Sportlots tab.
**Flags:** ✅ Meets all 8 rules (both Sportlots-tab taps are `centerElement`-guarded; 120s round-trip).

### profile/test-bsc-credentials.yaml
**Feature:** "Test Credentials" triggers a real BSC auth with seeded creds + shows the success banner; then the Clear lifecycle.
**Flags:**
- R5: `"Neon Binder" 45000` + `"Profile Settings" 30000` pure-UI → replace with one `assertVisible "Profile Settings"`.
- R6: `scrollUntilVisible ".*BSC account authenticated successfully.*"` then `assertVisible` → drop the assert.
- R3: Clear lifecycle overlap.

### profile/test-sportlots-credentials.yaml
**Feature:** "Test Credentials" triggers a real SL auth + success banner; then the Clear lifecycle.
**Flags:** Same as test-bsc: R5 `"Neon Binder"/"Profile Settings"` pure-UI waits, R6 redundant assert after the success-banner scroll, R3 Clear overlap.

#### Group: home + auth + dashboard — 8 flows, 6 with flags

### home/landing-smoke.yaml
**Feature:** Public landing renders primary CTAs ("Sign In", "Get Started", "Create Free Account").
**Flags:** R6 redundant `assertVisible "Create Free Account"` after its scroll → drop. R8 scroll missing `centerElement:true` → add.

### home/landing-marketing.yaml
**Feature:** Landing renders marketing sections (Free Tier, 3-feature grid, "How It Works").
**Flags:** R3 partial duplicate of landing-smoke (drop the opening "Neon Binder" assert here). R6 every scroll is followed by a redundant `assertVisible` (lines 12–15, 19–23, 30–33) → drop. R8 scrolls missing `centerElement:true`.

### home/ai-identification.yaml
**Feature:** AI Card Identification page renders its 4 sections; signed-out "Get Started" opens the Clerk sign-up dialog.
**Flags:** R2 the `when: visible "Get Started"` + `optional:true` scroll silently skips the CTA test when signed in → assert `"Sign out"` first OR force a signed-out context. R6 redundant asserts after section scrolls (19–27). R8 scrolls missing `centerElement:true`.

### home/collection-tracking.yaml
**Feature:** Collection Tracking page renders 4 sections; "Get Started" opens the sign-up dialog.
**Flags:** R2 unconditionally taps "Get Started" → hard-fails if signed in (Clerk suppresses the button) → add the `when:` guard. **R4/tag: missing `home` tag (only `marketing`)** → add. R6 redundant assert after the Get-Started scroll. R8 scrolls missing `centerElement:true`.

### home/managing-inventory.yaml
**Feature:** Managing Inventory page renders 4 sections; "Get Started" opens the sign-up dialog.
**Flags:** R2 same unconditional Get-Started tap → add the `when:` guard. R6 redundant assert after the Get-Started scroll. R8 scrolls missing `centerElement:true`.

### auth/sign-in.yaml
**Feature:** `/testing/sign-in` redirect lands the user authenticated on the dashboard.
**Flags:** R1/R2 only asserts "Sign out" — add a dashboard-specific assert so the feature is unambiguous.

### auth/sign-out.yaml
**Feature:** A signed-in user can sign out and return to the public landing page.
**Flags:** R8 `tapOn "Sign out"` has no scroll guard — header can be occluded at 1024×629 → add `scrollUntilVisible … centerElement:true`.

### dashboard/view-collection.yaml
**Feature:** Authenticated user sees the dashboard load with its "COMING SOON" placeholder.
**Flags:** R1/R2 coupled to a placeholder string — add a stable structural element and note this needs updating when real content ships.

#### Group: util + setup track — 5 flows, 4 with flags

### util/util-login-to-bsc.yaml
**Feature:** Refreshes the BSC Puppeteer session (re-login, writes fresh sellerId) so downstream flows get real card data.
**Flags:** R6 redundant `assertVisible` after the success-toast scroll → drop. **R8 (flake source): `scrollUntilVisible "Test Credentials"` lacks `centerElement:true`** → add (this is the CDP-scroll vector).

### util/util-login-to-sportlots.yaml
**Feature:** Refreshes the SL cookie session so downstream flows get live SL card data.
**Flags:** R5 `"Neon Binder" timeout:20000` pure nav wait → default. R6 redundant `assertVisible` after the success-toast scroll → drop. **R8 (CRITICAL — the reported flake source): `scrollUntilVisible "Test Credentials"` (lines 59–63) lacks `centerElement:true`** → add. This is the exact `MismatchedInputException` vector that failed `sets-base` and tonight's `setup.yaml` seed.

### setup.yaml
**Feature:** Global reset + warm worker-0 marketplace sessions + full drill + sync Base variant cards for 2024 Topps Chrome. Establishes the canonical pre-synced state.
**Flags:** **WIP comment present → remove.** R7 the "Reset Set Builder Data"/"Delete Everything" wipe is the ONE sanctioned destructive action — flag explicitly so reviewers don't trip on it. R6 `when: notVisible "Baseball"` falls through with no assert → add unconditional `assertVisible "Baseball"` after. R8 `tapOn "Baseball"` (143) + `tapOn "Base"` (260) lack centered scrolls → add. (Note: this flow inherits the `util-login-to-bsc` 20s wait + flake — see util fixes.)

### setup-insert.yaml
**Feature:** Pre-syncs Insert variant + "Future Stars" checklist (~20 cards) for 2024 Topps Chrome.
**Flags:** R6 `assertVisible ".*N matched.*BSC-only.*SL-only.*"` (line 72) is a single multi-token regex across likely-separate DOM nodes → will silently no-op-pass → split into 3 asserts. R6 redundant `assertVisible ".*Unmatched.*"` after its scroll → drop. R8 `tapOn "Insert"` scroll lacks `centerElement:true` → add. R5 `extendedWaitUntil "Insert" timeout:30000` post-drill → default.

### setup-parallel.yaml
**Feature:** Pre-syncs Parallel variant + "Gold Wave Refractors" checklist (~300 cards) for 2024 Topps Chrome.
**Flags:** Same as setup-insert: R6 multi-token `assertVisible` (line 60) → split into 3; R6 redundant `assertVisible ".*Unmatched.*"` → drop; R8 `tapOn "Parallel"` scroll → add `centerElement:true`; R5 `"Parallel" timeout:30000` → default.

---

## Suggested order of work (morning)
1. **Diagnose tonight's seed failure FIRST** — `setup.yaml`'s BaseSetPicker `Confirm Base Set` 45s timeout = SL base-set fetch for Topps Chrome returned no match (PostHog `adapter_sync_call`; transient vs. real SL gap). This is the blocker for validating `sets-base`. *(The `util-login` `centerElement` fix (R8) is still worth doing — the warm DID flake-and-recover — but it is NOT this failure.)* Re-run the queue once the seed is green.
2. **`refresh-sportlots-creds` (R7 destructive + invalid `optional:true` + mis-tag).** Real bug.
3. **Silent `when:` fall-throughs (R2)** — the flows that can green without testing their feature.
4. **Decide the shared-set-write isolation story under the queue** (topps-chrome-*, multi-source confirm) — lanes are gone.
5. **Mechanical sweeps:** R6 redundant-assert drop, R8 centerElement, R5 timeout trim — batch through `maestro-e2e-author`, group by group.
6. **Tag hygiene:** remove WIP comments (`setup.yaml`, `custom-entry-survives-resync`), fix tag inconsistencies, remove stale "DB reset" comments.
7. **Dedup proposal (R3)** — profile creds cluster, `edit-profile`, landing pair — propose before deleting (this is also the parked NEO-46 Phase-4 dedup task).
