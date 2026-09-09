---
name: toast-assert-after-enter-flake
description: Why "inputText + pressKey Enter + immediately assert toast" intermittently fails in local maestro-web even though the app is fine — and how to prove it's the harness, not a save regression
metadata:
  type: reference
---

SYMPTOM: a SetAttributesPanel / CardFeaturesEditor flow does `tapOn field` →
`eraseText` → `inputText NEWVALUE` → `pressKey: Enter` → immediately
`extendedWaitUntil { visible: ".*Updated N cards.*" }` (or ".*Saved X.*"), and the
toast assertion intermittently FAILS locally — even when NEWVALUE is a genuine
change from the stored value.

ROOT CAUSE (proven NEO-71-74, 2026-07-11): NOT an app/save regression. Two
compounding pre-existing TEST-HARNESS issues:
  1. NO-OP WEDGE: the field's editor (useReactiveField.runCommit `trimmed===baseline`
     AND the panel's handleSaveFeature `features[key]===trimmed`) legitimately skips
     the mutation when NEWVALUE already equals the stored value. A STATIC two-step
     "clearing sentinel" (write "RprtTest-X" then "RprtTest-SET1") self-wedges when a
     prior/interrupted run left the set at exactly "RprtTest-X" → first write no-ops →
     no toast. (Same class as the documented set-attributes 1900-01-01 wedge.)
  2. ENTER-COMMIT FLAKE: useReactiveField commits on onKeyDown Enter OR onBlur. The
     flow asserts the toast IMMEDIATELY after `pressKey Enter` with NO intervening
     blur/tap, so it depends on maestro-web actually dispatching a keydown React sees.
     LOCALLY this is intermittent: same flow caught the toast one run, missed it three
     others — and in EVERY miss the value STILL PERSISTED, proving the commit fired
     later (on teardown blur), just after the ~7-8s assert window closed. Interactive
     Chrome repro (edit field → Enter) fires the toast INSTANTLY & reliably every time.

DECISIVE DIAGNOSTIC (do this before calling a toast-miss a save regression):
  - Re-open the panel (re-drill or a fresh Chrome session) and read the field's
    default value. If it shows the value the flow typed, THE WRITE LANDED → the failure
    is toast-OBSERVATION timing, not a broken save path. (Convex mutations ride the
    WebSocket, so they DON'T appear in `read_network_requests` — judge success by the
    persisted value + the toast rendering, not by an HTTP request.)
  - Reproduce interactively in Chrome (mcp__claude-in-chrome): drill to the set, edit
    the field, press Enter, screenshot immediately. A green "Updated N card(s)" banner
    at top-center (fixed top-20) + no console errors = app is fine.

WHY CI IS USUALLY GREEN: fresh per-PR Convex preview → stored value starts "" → first
write is always a change (no wedge); and CI's maestro-web dispatches Enter more reliably
than the local self-signed-HTTPS laptop driver. So this flake is largely a LOCAL
shared-dev artifact; don't block a PR's "green" on it if interactive repro proves the app.

FLOW HARDENING (if you must make it locally deterministic — propose, it touches all
Enter-commit steps): make the first sentinel per-RUN-unique (guarantees a change), and/or
force a blur before the toast assert instead of relying on Enter alone. Note a longer
`inputText` value / `eraseText 60` did NOT help and may worsen the Enter timing — keep
eraseText ~20.
