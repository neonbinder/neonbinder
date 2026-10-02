---
name: reuse-the-status-ledger-spinner-to-check-pattern
description: Owner-approved pattern (NEO-312) — any multi-item background run shows a ledger of one line per item whose glyph goes clock → spinning arrows → check (or a state glyph), with a decorative "sleeve strip"; reuse it instead of inventing a new progress UI
metadata:
  type: feedback
---

**The pattern** is from `components/SetSelector/ParallelBuildPanel.tsx`, the NEO-312 parallel build.

A run over N items (here, an insert's parallels) is shown as a **ledger**: one line per item, reading `{item} — {status}`.
- **Glyph.** Each line has a 16px Heroicons outline glyph that changes with the item's state (`LINE_GLYPH`):
  - waiting: `ClockIcon`
  - building: `ArrowPathIcon` + `motion-safe:animate-spin`
  - built: `CheckIcon`, in neon green `#00D558`
  - skipped: `MinusCircleIcon`
  - blocked: `NoSymbolIcon`, amber
  - stopped: `StopCircleIcon`
  - failed: `ExclamationTriangleIcon`, pink
  - unfinished: `ClockIcon`, amber
- **Glyph accessibility.** The glyph is `aria-hidden`; the line's text says the state in words. Colours are the `-700` light / neon dark pairs that clear 4.5:1.
- **Sleeve strip.** Above the ledger, an `aria-hidden` strip holds one card-shaped slot per item (`SLEEVE_TONE`: `h-3.5 w-2.5 rounded-[2px] border`). The slots fill "like a binder page" as each item lands; the building slot pulses (`motion-safe:animate-pulse`). Each slot's `title` repeats its line.
- **Around it:**
  - a heading with `k of M` while running and a summary of only the non-zero parts when done;
  - a polite live region that announces the start, each blocked or failed item, and the end (built items are coalesced into pulses on large runs);
  - a `Stop after this one` control;
  - lines that open as disclosures listing per-item detail.

**Why:** Jason, 2026-10-02, reviewing PR #291's preview: the spinner-to-check-mark UI "is really good and needs to be a pattern we reuse."

**How to apply:**
- Reuse this for any operation that processes several items in the background or in sequence: bulk builds, batch syncs, bulk loads, multi-item saves. Don't design a new progress bar or spinner list.
- If a second surface needs it, extract the glyph map, the sleeve strip and the ledger line into a shared component instead of copying them.
- Keep these intact:
  - words carry the state, with glyphs and colour as reinforcement;
  - every animation sits behind `motion-safe:`;
  - each line is one text node, so E2E can read it whole.
- Consult the frontend-design skill as usual; this is the starting point, not a replacement.
