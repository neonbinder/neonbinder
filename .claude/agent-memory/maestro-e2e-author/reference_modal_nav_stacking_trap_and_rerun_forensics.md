---
name: modal-nav-stacking-trap-and-rerun-forensics
description: NEO-80 root cause — wide inline set-selector modals get occluded by the z-30 nav rail at the 1024px CI viewport (viewTransitionName stacking trap); plus the gh-run-rerun stale-queue forensic method
metadata:
  type: reference
---

Two durable findings from the NEO-80 forensic investigation (2026-07-01, non-deterministic
set-selector E2E failures). See [[project_neo63_breakout_removal_col4_navoverlap]] (that one is
COLUMNS; this is MODALS — a distinct, still-open issue as of NEO-80).

## 1. The modal ↔ nav-rail stacking trap (a real product bug; flow-author gotcha)

`src/layouts/binder-layout.tsx` wraps `<Outlet/>` in
`<div style={{ viewTransitionName: "page-content" }}>`. A non-`none` `view-transition-name`
**creates a stacking context** (Chrome), so every modal a binder page renders is scoped inside it.
`<BinderTabs/>` (the right-edge nav rail, `fixed right-0 top-1/2 z-30 hidden lg:flex`) is a
**root-level sibling of `<main>`**. Net: the nav's z-30 **paints OVER** any page modal's z-50 —
the modal's z-50 is trapped at the page level, below the root nav.

Consequences for Maestro flows:
- Tailwind `lg` == **1024px**, and the CI headless viewport is **exactly 1024×625**, so the nav
  rail IS shown in CI and occupies the right ~170px (x≈854-1024).
- Any modal wide enough to put buttons in that zone loses taps there. `AttachSetsDialog`
  (`max-w-5xl` = 1024px) puts its footer Cancel/Attach at x≈806-965 → **the Cancel tap is
  stolen/misdirected by the nav overlay, so the dialog never closes** (the `multi-source-panel-
  opens-dialog` flake: `assertNotVisible: Search BSC sets` fails post-Cancel — the dialog OPENED
  fine; it failed to CLOSE). `ReconciliationModal` is `max-w-6xl` (even wider) — same risk.
- `CardDetailPanel` does NOT flake here because it renders via `createPortal(document.body)`,
  escaping the stacking trap. **The fix is to portal the inline modals** (AttachSetsDialog,
  ReconciliationModal, ParallelGroupingModal, BaseSetPicker, UnknownEntitiesDialog) like
  CardDetailPanel already does — an app-code change, NOT a flow change.
- Until fixed: when authoring/ debugging a flow that taps a wide-modal footer button, know the
  right ~170px is a nav-steal zone at 1024px even though the modal is z-50 (occlusion doesn't
  affect `assertVisible`, only taps). Ties into R8 (right-edge occlusion by the fixed BinderTabs rail).

## 2. `gh run rerun` = stale-queue re-read (NEO-49 queue); forensic method

`gh run rerun` reuses `E2E_RUN_ID`, so the seed step logs
`Enqueued 40 flow(s): {"alreadySeeded":true,"inserted":0}` and **every runner drains 0 flows**
(`Runner N ran 0 flow(s)`); the gate just re-reads the prior attempt's `failed:1`. So a rerun
produces NO fresh evidence and the "failed flow" is stale.

To investigate a failed E2E run correctly:
- Check `gh api repos/OWNER/REPO/actions/runs/<id> -q .run_attempt`. If `run_attempt > 1`, the
  visible artifacts/gate are the RERUN's — the real failure is in an earlier attempt.
- The uploaded `maestro-report-runner-N` artifacts + `logs/runner-N.results` capture only the
  **Phase-0 bootstrap**; the drain-phase per-flow results/screenshots for a PASSED run aren't
  there. The failing runner's report is larger (bundles the failure screenshot + maestro.log) —
  spot it by artifact byte size. Per-flow drain output (`▶/✅/❌ [rN] <flow>`, `[Failed] … (Assertion …)`)
  lives in the **job stdout logs**: `gh run view --job <jobId> --log`.
- Attempt-1 artifacts 404 after a rerun (`/attempts/1/artifacts`), but attempt-1 **job logs**
  survive: `gh api repos/OWNER/REPO/actions/runs/<id>/attempts/1/jobs`.
- The failure screenshot + `debug/<flow>/maestro.log` is the ground truth — read the actual
  RUNNING/COMPLETED/FAILED command trace, don't trust the one-line gate summary (NEO-80's ticket
  summary inverted "dialog didn't open" vs the real "dialog didn't close").
