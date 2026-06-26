# Flow #26 — `set-selector/custom-entry-survives-resync` — Walk Plan (2026-06-15)

**For review.** Tracker had `#26 → DECISION: _____`, but the file was already walked over the
weekend (WIP comment gone, R4 re-login removed, R5/R6/R8 applied, R2 error-path handler added).
This plan = the per-rule verdict on the **current** file + the **one structural decision** left.

## R1 — Feature
A user-added **custom sport** entry survives a marketplace **re-sync** (Sync Sports), and its
**"Custom"** badge persists. Also the sole exerciser of the manual **"Sync Sports"** button now
that `#25 set-selector-smoke` was deleted → #26 inherits that coverage (note for R3).

## Per-rule verdict on the current file
| Rule | Status | Notes |
|---|---|---|
| R1 feature | ✅ | clear, single feature |
| **R2 assert-only** | 🔴 **FINDING** | **survival assertion is vacuous after run 1** (see below). Error-path handler (aborted-sync) ✅ already added. |
| R3 dedup | ✅ | unique (only custom-survival test); absorbs #25's Sync-Sports coverage |
| R4 independent | ✅ | re-login removed; relies on bootstrap-seeded creds |
| R5 waits | ✅ | UI mounts at 7s; kept 60s/30s cold sports auto-sync + 55s sync-cycle (real marketplace round-trips) |
| R6 redundant assert | ✅ | every `scrollUntilVisible` is followed by `tapOn`, not a redundant assert |
| R7 destructive | ✅ | adds an entry + syncs; nothing destructive |
| R8 centerElement | ✅ | both scrolls (`Add custom Sports`, `Sync Sports`) have `centerElement: true` |
| +9 tags | ✅ | `set-selector`, `regression`; WIP comment removed |

## The R2 finding (the only real issue)
**The custom-sport name is stable: `TestCustomSport-${TEST_USERNAME}`, and `TEST_USERNAME` is
fixed per worker** (`neontester-r<N>`). Confirmed facts:
- Custom `selectorOptions` rows are **GLOBAL** — `isCustom`/`createdByUserId` are an audit trail,
  not a visibility scope (no `by_user` index; custom sports render in everyone's Sports column).
- The bootstrap reset (`resetMyTestState`) is **caller-scoped and never touches `selectorOptions`**.
  Only the admin-gated `resetSetBuilderData` global wipe clears them.

⇒ Run 1 creates `TestCustomSport-neontester-r0` and it **persists forever**. On every later run,
STEP 3's `assertVisible "TestCustomSport-neontester-r0"` passes because the **old** row is still
there — **even if this run's sync had deleted the freshly-created one**. The test cannot
distinguish "survived this sync" from "left over from a prior run" → **vacuous after the first run**
(violates "actual product value per test").

## Recommended fix (single path)
**Switch the custom-sport name `${TEST_USERNAME}` → `${ATTEMPT_ID}` (8 refs in this flow).**
- `ATTEMPT_ID` is injected fresh per attempt by the runner (`run-e2e-queue.sh:120`) and is already
  the proven fresh-marker in **11 flows** (team-picker, #5 keyboard-only, #28 move-parallels, …).
- Makes the survival assertion **real**: the entry created *this run* is the one verified to survive.
- Mechanically a clean find/replace — `TEST_USERNAME` is used only for the sport name here (URL uses
  `WORKER_INDEX`); no structural change to the search/badge logic.
- **Delegate the edit to `maestro-e2e-author`**, then validate through the harness.

## The trade-off you need to weigh (the decision)
`ATTEMPT_ID` ⇒ **+1 permanent global custom-sport row per local run** in the **non-deletable**
`selectorOptions` (sport level). This is **exactly the #28-class pollution you just had to manually
reset** — and it's worse than the card-flows' pollution (those accrete in the *deletable*
`cardChecklist` inside a stable reused set; #26 accretes top-level sports that nothing can delete).

- **CI is unaffected** (fresh Convex preview per run).
- **Locally**, clear between batches with the **"Reset Set Builder Data"** admin button (already the
  documented pollution-clear step in the harness doc).
- The real cure is the **filed Linear item** (selectorOptions delete capability) — once it lands,
  #26 can create→verify→**self-delete** with a fresh marker and **zero net pollution**. That's the
  proper end state; ATTEMPT_ID-now is the bridge.

**Confirm one of:**
- **(A — recommended) Real test now:** ship the `ATTEMPT_ID` swap; accept bounded local pollution;
  prioritize the delete-capability item to reach self-cleaning. Matches your "real product value" bar.
- **(B — lower pollution, honest downgrade):** keep the stable name, **rename the flow** to an honest
  "manual Sync Sports runs + a custom entry renders with its badge" smoke, and **drop the "survives"
  claim**; defer true survival coverage until the delete capability lands. Zero new pollution, weaker
  guarantee.

## After the decision
1. maestro-e2e-author applies (A) or (B).
2. Validate via harness: `./e2e-enqueue.sh .maestro/flows/set-selector/custom-entry-survives-resync.yaml` → `./e2e-watch.sh …`.
3. Update the tracker: mark #26 walked + decided; note it absorbs #25's Sync-Sports coverage; if (A),
   add the cross-ref to the selectorOptions-delete Linear item.
