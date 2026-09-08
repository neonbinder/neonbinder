---
name: maestro-web-tap-reliability
description: maestro-web tap failure classes (null→Int CDP crash on self-unmounting taps, silently-dropped cold taps) and the empirically-confirmed ~7s cost of a `when:` conditional retry; EntitySelector select behavior
metadata:
  type: reference
---

## The CDP dropped-tap class (a tap "COMPLETED" ≠ app registered the click) — the ONE reliable tool
`retryTapIfNoChange` is DEFAULT-TRUE but is fooled by ambient Convex reactivity: on a reactive page, background re-renders satisfy Maestro's "did the hierarchy change?" check, so it concludes the tap worked even when the intended click never fired (PROVEN — NEO-81 iter2 run 28637057704 r4: the "Insert" tap logged `hierarchyBasedTap: Something has changed… Proceed` yet `selectedVariantTypeId` stayed null). So NEITHER `retryTapIfNoChange` NOR `waitToSettleTimeoutMs` removal reliably self-heals a dropped tap. **The reliable self-heal is a scoped retry keyed on the tap's SPECIFIC RESULT, not "did anything change":**
```yaml
- retry:
    maxRetries: 1
    commands:
      - tapOn: <the row/trigger/close>
      - <extendedWaitUntil/assertVisible/notVisible of the ONE element that proves it worked>
```
maestro 2.6 supports `retry`. maxRetries:1 = 2 attempts. Result signals proven in NEO-81:
- **Row-select** (search box + tap filtered row → next column mounts): result = `notVisible: {id: "Search <level>"}` (the level's search box vanishes on a registered select) OR the next column header. Fail-loud alone (notVisible without retry) LOCALIZES but does NOT self-heal — wrap it in `retry` to self-heal.
- **Dialog/panel OPEN trigger**: result = `assertVisible` the dialog-only element (multi-source "Attach more…"→"Search BSC sets"; Group Parallels→"Drag inserts under a parent"). Happy path opens <1s so no re-tap/double-open.
- **Dialog CLOSE tap (Cancel/Save/Done)**: result = `notVisible` the dialog-only element (multi-source Cancel→"Search BSC sets" gone). PROVEN needed (iter2 run 28637606132 r6: Cancel COMPLETED, portaled dialog stayed open — modal was above the nav so NOT occlusion).
- **Variant-type/Variant select in util-drill-to-custom**: result = pluralized column header (`.*${VARIANT_TYPE}s.*`) / CardChecklist "Open add card form".
DON'T wrap fetch-gated dialogs ("Confirm New Players & Teams" waits on a 60s marketplace fetch — a re-tap would re-fetch). Geometry-check a suspected close-drop before assuming occlusion: a portaled dialog (NEO-80) renders ABOVE the z-30 nav, so its buttons are on top (see [[flake-runtime-forensics]] for reading tap bounds vs nav band).
- **Convex read-stall** (column mounted but "Loading X…", getSelectorOptions undefined) is a DIFFERENT bucket → FE backstop (NEO-83), not a retry.

## maestro-web CDP driver-crash class → RUN-LEVEL crash-only retry (not in-flow)
The maestro-web-Beta CDP driver intermittently dies with `null cannot be cast to non-null type kotlin.Int` (ClassCastException in `CdpWebDriver.deviceInfo`/`ViewHierarchy` read; maestro issue #2944). It can crash MID-COMMAND (even inside an in-flow `retry`), so NO in-flow retry catches it — the driver itself is dead. Fix = a crash-only retry in the drain harness (`run-e2e-queue.sh` `run_flow`): grant ONE extra attempt on the crash signature, NEVER on an assertion (real bugs must stay visible). **Discriminator = the per-flow junit `<failure>` MESSAGE, NOT `status`** — maestro sets `status="ERROR"` for BOTH crashes AND assertion failures (verified), so status is useless. Retry iff junit `<failure>…>Unknown error` AND NOT (`Assertion is false` | `No visible element found`). Proven on real junits: the crash matches, every assertion-fail is rejected. Timeouts (exit 124/137) still never retried. Durable fix (not harness): pin/adjust the maestro-web version to dodge #2944. (NEO-81 iter6, run 28656410552 r5.)

## Auth-transient opener class (NOT a tap — a page-load/sign-in stall)
Every flow opens `launchApp` → `/testing/sign-in?redirect=<route>` → assert landing heading. Under concurrent Phase-0 sign-in (8 workers authenticating at once) the Clerk→Convex auth handshake can stall past the heading-wait, leaving the page on "[testing-reset] Waiting for authentication…" (or bounced to /signin) so the heading never renders (NEO-81 iter4/5: worker-bootstrap run 28647629347, set-attributes-edit run 28651468095). Screenshot signature: blank page with "Waiting for authentication…", NO taps in the segment. Fix = wrap the opening `[launchApp → landing-heading assert]` pair in `retry:{maxRetries:1}` (re-drive sign-in ONLY if the heading missed; sign-in/reset/seed redirects are idempotent; no timeout bump). Intended suite-wide, but **CORRECTED 2026-09-02: it is NOT applied suite-wide** — only 6 flows contain a `retry:` at all (`grep -rl 'retry:' .maestro/flows`), and none of the mainstream set-selector flows (team-picker, custom-card-crud, features-propagation…) wrap their opener. The plain `launchApp` + `extendedWaitUntil <heading> timeout:45000` pair is the de-facto convention; add the wrapper only if you actually observe the stall. Skip: flows that tap immediately after launchApp (sign-out), signed-out clearState→public re-launches, and utils/sub-flows run in the caller's session (no launchApp). **Systemic root (durable fix, not flow-layer): stagger Phase-0 sign-in (jitter per WORKER_INDEX) or harden the Clerk→Convex handshake** — the retry only mitigates.

Durable maestro-web tap facts (confirmed via NEO-39 forensics on credentials-lifecycle + the drill utils):

1. **CDP crash signature `null cannot be cast to non-null type kotlin.Int`** = maestro's
   POST-tap view-hierarchy read hit a transient null-bounds DOM node. Triggered when the
   tapped element's onClick synchronously UNMOUNTS itself and/or fires a heavy re-render
   (e.g. the "Yes, Clear" confirm button → `setConfirmingClear(false)` + swaps the view).
   Deterministic on a COLD page where the unmount re-render overlaps still-flushing Convex
   reactive bursts; warm pages survive. The scoped per-flow retry (run-e2e-queue.sh /
   run-e2e-smoke.sh) greps for "cannot be cast to non-null type" — this crash class is what
   it backstops. Flow-level fix: **reload the route BEFORE the self-unmounting tap** to
   discard in-flight reactive bursts so the only re-render at tap time is the clean one
   (NEO-39 credentials-lifecycle: reload before BSC + SL step-b clears, mirroring the
   already-stable step-d clears).

2. **A maestro tap logged "COMPLETED" does NOT mean the app registered the click.** On a
   cold render the click can land on a stale/re-rendering node and the selection is silently
   dropped (no error, no crash — just no effect; next column never mounts → a later plain
   `Assertion is false: X` with NO crash signature, which the scoped CDP-crash retry will
   NOT catch). Fix: settle the target in place before tapping, then VERIFY the result and
   re-issue the action if it didn't take (NEO-39 topps drill: Year→Manufacturer lost tap).

3. **A `when:` conditional polls the FULL default window (~7s) before resolving the skip
   branch** — measured in CI logs: `when: visible: X` with X absent polled 7.57s then
   SKIPPED; by symmetry `when: notVisible: X` with X present polls ~7s then skips. So ANY
   conditional retry (`runFlow when: ... → re-tap`) costs ~7s on the happy path. This is the
   hard R10 tension: a lost-tap net with the per-flow retry OFF is worth the ~7s — document
   it as a deliberate exception. Guard the re-tap on a signal that is FAST-true on the lost
   path AND guarantees the target still exists (see #4).

4. **EntitySelector select behavior** (components/SetSelector/EntitySelector.tsx): tapping a
   row is a pure FE state update; on select the column COLLAPSES — the "Search <col>" input
   and the row list are removed ATOMICALLY (one render) — and the next column mounts. The
   header renders the instant its getSelectorOptions query resolves (even to []), so a
   missing next-column header means the query is still loading OR the select was lost, NOT a
   marketplace fetch (that only fires on an empty subtree AFTER the column mounts). Parent
   handlers (SetSelector.tsx handleYearSelect etc.) are `setSelectedXId(id); clearFrom(n+1)`
   — NON-toggling, so re-selecting the SAME row is idempotent (safe to re-tap). Therefore
   "the `Search years` input is still visible" is a clean, safe lost-tap detector for the
   Year select: present ⇔ not yet selected ⇔ row still there to re-tap. Search input only
   renders when a column has >8 items (real-synced); custom/short columns have none.

Related: [[patterns_util_drill_to_custom]] (the drill the Year-select net lives in).
