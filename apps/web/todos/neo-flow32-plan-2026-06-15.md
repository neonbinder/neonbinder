# Flow #32 — `set-selector/set-attributes-edit` — Walk Plan (2026-06-15)

**The next flow after #26/#28.** Tracker had `#32 → DECISION: _____`; the 06-11 resume worklog
recorded it RED on an "intermittent Clerk login" (stuck on /signin while 3 other flows signed in
fine same batch — that was the **pre-SerialGC JVM-crash era**, since fixed). So this plan = the
8-rule cleanup + a **re-validation** to confirm the sign-in red is gone.

## R1 — Feature
`SetAttributesPanel` on a per-worker custom set (`attr-edit-${WORKER_INDEX}` under Baseball/2024/Topps):
breadcrumb scope text, setName-level metadata edit (Release Date / Block / TCDB Set ID / Source URL)
with save toasts, collapse/expand toggle, and breadcrumb update when drilling to a child variant type.

## Per-rule verdict on the current file
| Rule | Status | Notes |
|---|---|---|
| R1 feature | ✅ | clear, multi-part but one coherent feature (the panel) |
| R2 assert-only | ✅ | idempotent-expand `when: visible id:"Edit attributes"` branches are guarded by `assertVisible id:"Hide attributes"` — the hard post-guard. No silent fall-through. |
| R3 dedup | ✅ | unique (sole SetAttributesPanel test); already folded the deleted `set-features-panel`'s `"Will propagate to N"` assert |
| R4 independent | ✅ | per-worker custom set, no re-login (bootstrap-seeded); shares `util-drill-to-custom` |
| **R5 waits** | 🟡 **cleanup** | see below |
| R6 redundant assert | ✅ | the `assertVisible "Value for X"` after a scroll target a *different* element (scroll to the field below to lift X into view) — intentional, not redundant |
| R7 destructive | ✅ | edits metadata on a per-worker custom set |
| **R8 centerElement** | 🟡 **cleanup** | PART F scroll missing it (below) |
| +9 tags | ✅ | `regression`, `set-selector` |

## The cleanup findings (single decision: clean + re-validate)
1. **R5 — the 7 metadata save-toast waits are `timeout: 15000` (lines 145/156/172/201/212/228/238).**
   These wait on `".*Saved <field>.*"` after a `setSetMetadata` **Convex write**. Per our rule (ALL Convex
   writes settle in 7s; a >7s write is a *finding*), trim each to **7s**. If any metadata save toast
   genuinely needs >7s, that's a real backend finding to chase — surface it, don't pad.
2. **R8 — PART F's `scrollUntilVisible id:"Add custom Variant Types"` (lines 293-298) has no `centerElement: true`** —
   it uses `direction: UP, visibilityPercentage: 100` only. This is the **same below-fold class as #28**:
   NEO-47's taller empty-state can push the "+ Custom" button into the footer-steal zone. Add
   `centerElement: true` (places it at y≈315, clear of header *and* footer). Also trim the 30s scroll
   `timeout` toward ~15s (scroll, not a backend wait).
3. **KEEP the 45s `"Set Selector"` sign-in wait (lines 60-62).** It's a *real* cold-auth round-trip +
   the documented Nth-concurrent-sign-in Clerk rate-limit backoff under parallelism (matches team-picker's
   gate). Not inflated UI — do **not** trim.

## The Clerk-login red (06-11) — re-validate, don't assume
The 06-11 "stuck on /signin" failure coincided with the JVM-SIGSEGV era (fixed by `-XX:+UseSerialGC`).
**Plan: re-enqueue #32 on the harness after the cleanup.** If it goes green → the red was the old infra.
If it **still** stalls at sign-in → forensics FIRST (per our hard rule — never call it "flaky/Clerk"):
read the failure screenshot + junit, query PostHog `credential_test_failed`, check Clerk testing-token
issuance under parallel sign-ins. No speculative fix until evidence.

## Decision (single path)
**Cleanup + re-validate:** trim the 7 save-toast waits → 7s, add `centerElement` to PART F's VT scroll,
keep the 45s sign-in guard. Route the edit through `maestro-e2e-author` (edit-only), then enqueue #32
on the harness. Treat any sign-in stall or >7s save as an evidence-first finding, not a pad.

## After the decision
1. maestro-e2e-author applies the cleanup.
2. Validate: `./e2e-enqueue.sh .maestro/flows/set-selector/set-attributes-edit.yaml` → watch.
3. Update tracker: mark #32 walked + GREEN (or record the forensic finding if the sign-in red recurs).
