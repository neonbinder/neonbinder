---
name: reference_base_mapping_picker_paths
description: BaseSetPicker / BaseMappingForm test facts — the cancel dead-end is auto-open-path-ONLY, "Topps Big League" is the validated fresh Path-A set, and the "Confirm Base Set" loaded-gate is a set-agnostic Path-A proof
metadata:
  type: reference
---

BaseSetPicker (`components/SetSelector/BaseSetPicker.tsx`) + BaseMappingForm
(`components/SetSelector/BaseMappingForm.tsx`) — the "Select Base Set" modal shown
when a **Base** variantType maps its SportLots equivalent.

**Two open paths (doSync in BaseMappingForm):**
- **Path A** — SL returns >0 base options → picker STAYS open, user confirms inside it.
- **Path B** — SL returns 0 → picker auto-closes, BSC fallback written, a `message`
  panel + "Re-map Base" show. (`Select Base Set` flashes <500ms → not assertable.)

**Set-agnostic Path-A gate (no per-set match text needed):** wait for the Confirm
button text **"Confirm Base Set"** (it reads "Loading…" while the SL fetch is in
flight, and flips only once slOptions rendered). A LOADED picker is itself proof SL
returned options — if SL were empty, doSync would have closed the picker before the
button ever read "Confirm Base Set". This absorbs the live SL round-trip (~60s budget).

**The Cancel dead-end (NEO-71-74 fix) is FIRST-TIME AUTO-OPEN-PATH ONLY.** The bug
(cancel → frozen, no picker/no Re-map/no retry) manifests ONLY on an UNMAPPED Base:
baseHasMapping stays false → SetSelector keeps rendering the SAME BaseMappingForm
instance (React key unchanged) whose internal `triggered` ref is frozen → silent
nothing. On the **Re-map path** (baseHasMapping already true) cancel was ALWAYS
recoverable (returns the "Re-map Base" button), so a Re-map-based test would pass
even if the freeze regressed — NOT a faithful regression test (R2). Reproduce the
real path: fresh UNMAPPED set → tap Base (autoOpen) → Cancel → assert
`.*Base mapping cancelled.*` + `Retry` → tap Retry → assert loaded picker reopens.
In the unmapped path, **"Close" is a no-op** (message panel just re-renders, no clean
return) — the clean "Re-map Base" return only exists on the already-mapped path.

**Validated fresh Path-A set: `2024 Topps Big League`.** Real, single clean base, SL
returns options (Path A). NOT touched by any other flow — setup.yaml maps 2024 Topps
**Chrome** (→ auto-open won't fire), sets-base.yaml CONFIRMS 2024 Topps **Heritage**
(→ globally mapped, same problem). Use Big League for auto-open base-picker tests and
**NEVER Confirm** → platformData.sportlots stays unwritten → non-destructive (R7) +
collision-free on the GLOBAL selectorOptions (drive via
util-drill-to-2024-topps-chrome `env: SET: "Topps Big League"`; its 60s "Base" ceiling
absorbs the cold variant-type sync). Flow: `set-selector/base-mapping-cancel-recovers.yaml`
(green 47s, 2026-07-16, via test:e2e:pick — warm SL, Big League already synced on
shared dev). Re-map Base blocker from [[neo63-navoverlap-resolved-and-base-blocker]]
is RESOLVED on neo-71-74 (sets-base/util-drill-to-base-variant depend on it, CI green).

**CI-only Retry-tap transient miss (run 29803189868 r7, 2026-07-21).** The post-Cancel
"Retry" tap can no-op under the parallel queue: after Cancel the recovery message +
Retry render fine, but tapping Retry leaves the message UNCHANGED ("Base mapping
cancelled") and the picker closed → `extendedWaitUntil "Select Base Set"` fails. The
unchanged message is decisive: `BaseMappingForm.doSync` reached none of its
setMessage/setPickerOpen(true) lines (they run BEFORE the awaited SL fetch) → it
**early-returned at the `!sportValue||!yearValue||!setNameValue` guard** because its
`getAncestorChain` useQuery was transiently `undefined` during a reactive refetch
(blank refetching column in the screenshot corroborates). Trigger = cross-worker
mutations to the GLOBAL `selectorOptions` table — the SAME transient-undefined the
parent SetSelector already guards via `stableVariantTypeFlagsRef` (SetSelector.tsx
~L88-127); BaseMappingForm's Retry path has NO equivalent guard. Indistinguishable
co-contributor: a dropped maestro-web tap during the same reflow (NEO-85). Single-worker
local can't reproduce (passed 07-16 + fix-run 07-21, 51s). FLOW FIX applied: wrap the
Retry tap + first "Select Base Set" wait in `retry: maxRetries:1` w/ retryTapIfNoChange
(mirrors the "Base"-tap retry). R2-PRESERVED: a permanent frozen dead-end (the `triggered`
ref the fix removed) fails BOTH attempts → still fails loudly. PRODUCT-HARDENING follow-up
recommended (user's call): make doSync resilient to a transient-undefined ancestorChain
(open picker before the guard, or stabilize sport/year/setName like the parent).
