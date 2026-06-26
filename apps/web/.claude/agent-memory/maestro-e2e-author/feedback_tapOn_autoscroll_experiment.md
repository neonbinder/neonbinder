---
name: tapOn-autoscroll-experiment
description: Experiment results (2026-06-20): tapOn does NOT auto-scroll to below-fold elements on Maestro web headless; scrollUntilVisible is non-negotiable for below-fold targets
metadata:
  type: feedback
---

# Maestro Web `tapOn` Auto-Scroll — DEFINITIVE RESULT (2026-06-20)

## Claim Tested
Maestro 1.21.0+ docs say `tapOn` will auto-scroll to an out-of-viewport in-DOM element before tapping. We tested whether this holds for Maestro web headless (2.6.0, Chrome CDP driver).

## Results Summary (5 runs each, local headless, 1024×629 and 1024×900)

| Hypothesis | Variant | Viewport | Pass Rate | Median Time |
|---|---|---|---|---|
| H1-A (current) | scrollUntilVisible+centerElement → tapOn "Sync Sports" | 1024×629 | 5/5 | ~39s |
| H1-B / H2 (proposed) | direct tapOn "Sync Sports" (no scroll) | 1024×629 | 0/5 | N/A (all failed) |
| H3-A (current at tall viewport) | scrollUntilVisible+centerElement → tapOn "Sync Sports" | 1024×900 | 5/5 | ~22s |
| H3-B (proposed at tall viewport) | direct tapOn "Sync Sports" (no scroll) | 1024×900 | 0/5 | N/A (all failed) |

## Key Findings

**H1/H2: `tapOn` does NOT auto-scroll on web headless.** The failure mode is "Element not found" (not wrong coordinates) — Maestro's accessibility tree snapshot only captures elements in the current viewport. A below-fold element is completely invisible to `tapOn` until you scroll it into view. `scrollUntilVisible` is NOT redundant — it is required.

**H3 (taller viewport): Pass rate unchanged, but scroll IS faster.** At 1024×900, `scrollUntilVisible` for "Sync Sports" takes ~10.5s vs ~13.4s at 629px. The improvement is simply a shorter scroll distance (fewer rows below fold). Pass rate 5/5 at both, but `--screen-size 1024×900` would reduce scroll time by ~2.9s per "Sync Sports" scroll. However, the Sports list grows over CI runs (accumulated test sports), so the benefit decreases over time and is not a robust strategy.

**"Failed to execute JS" check**: NOT relevant to pass/fail in these experiments — all PASS runs showed zero JS errors; all FAIL runs showed the "Element not found" error, not a JS error.

## How to Apply

- **NEVER drop a `scrollUntilVisible` because "Maestro 1.21.0 auto-scrolls".** That changelog claim does NOT apply to web/CDP/headless mode. Every below-fold element needs explicit `scrollUntilVisible` before `tapOn`.
- **`--screen-size 1024x900` is NOT a substitute for scrollUntilVisible** — it reduces scroll distance but doesn't eliminate the need. The 283 existing `scrollUntilVisible` calls in the suite are ALL load-bearing.
- **Speed lever**: if you want to reduce scroll cost, reduce action count (deep-link to a later page state) — not a taller viewport. The 2s/tap and 10-13s/scroll are fixed costs of the CDP driver.

## Experimental Context

- "Sync Sports" button is below the 629px AND 900px fold because the Sports list accumulates many entries over CI runs (E2E Test Sport 0, 1, 2, Baseball, Basketball, Boxing, Cricket, Football, ...). "Sync Sports" sits at the bottom of this list.
- The page layout on /set-selector: AdminTools panel first (y≈265–360), then Sports column starts at y≈430. The column has internal overflow-y scroll. At 629px: "Sync Sports" at y≈700+. At 900px: still y≈1000+.
- Timing breakdown at 900px: `scrollUntilVisible` = 10507ms, `tapOn` = 1977ms.

**Why:** Mobile Maestro auto-scroll works because it drives the native accessibility tree where off-screen views are registered. Web/CDP mode uses the CDP accessibility snapshot, which only captures visible elements. The two behaviors are NOT equivalent.
