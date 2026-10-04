---
name: feedback-result-ledgers-grow-the-page-scrolls
description: A results/progress list the operator reads (the parallel-build ledger) grows with its content and the PAGE scrolls — never a short max-h-48 inner scroller over empty screen
metadata:
  type: feedback
---

A ledger or result list the operator reads line by line grows to its content
height; the page scrolls, not a nested box. A viewport-relative cap
(`max-h-[70vh]`, still keyboard-focusable) is allowed only past a
pathological line count (ParallelBuildPanel: `SCROLL_AFTER = 100`, chosen so
100 lines are already taller than 70vh on any screen).

**Why:** Jason on the NEO-321 preview — the build ledger's `max-h-48` box
showed 5 of 42 lines above a large blank area: "lets let this box grow in
height there is no reason to make it short and leave all that blank space at
the bottom of the screen". A nested scroller is also unreachable by
maestro-web (its only scroll moves the window).

**How to apply:** for any new status/result list, size it by content first;
reserve `max-h-*` inner scrolling for pickers/dropdowns (SportSwitch,
SearchableDropdown) and for counts no real set reaches. Reusing the ledger
pattern — see [[feedback_reuse_the_status_ledger_spinner_to_check_pattern]].
