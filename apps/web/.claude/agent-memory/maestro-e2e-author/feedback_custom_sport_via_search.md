---
name: feedback_custom_sport_via_search
description: How to add a custom sport when the EntitySelector Sports search shows "No matches found" — don't erase, just tap Add custom Sports directly
metadata:
  type: feedback
---

When `util-drill-to-custom.yaml` drills a synthetic sport (e.g. "E2E Test Sport 0") and the Sports search shows "No matches found", the correct approach is:

1. `scrollUntilVisible: element: id: "Add custom Sports", centerElement: true, timeout: 10000` — the button is at y≈520 in the 1024×629 viewport (footer-steal zone), centering is required
2. `tapOn: id: "Add custom Sports"` — opens the Add Custom Entry modal
3. `inputText: ${SPORT}` — types into the modal's fresh auto-focused input
4. `pressKey: Enter` — saves
5. `extendedWaitUntil: notVisible: "Add Custom Entry"` — wait for modal close
6. `extendedWaitUntil: visible: text: ".*${SPORT}.*" below: id: "Search sports"` — the search input STILL HAS the sport name typed in it, so the newly created sport row appears automatically below
7. `tapOn: text: ".*${SPORT}.*" below: id: "Search sports"` — tap the result row

**Why NOT eraseText:**
- The `when:` check before this block takes ~7s (Maestro polling). During that time the EntitySelector re-renders its search input element. By the time the branch fires, the element reference is STALE → `eraseText` throws `StaleElementReferenceException`.
- Even with a re-tap before eraseText to refresh the reference, `eraseText: 50` on "E2E Test Sport 0" (17 chars) leaves "0" behind (the cursor-trap bug: cursor placed at position N-1, eraseText backward leaves the last char at position N-1).
- The residual "0" causes "No matches found" to persist even after the sport is created (search filter = "0" doesn't match "E2E Test Sport 0").

**Why the page is safe to CDP-scroll here:**
- The page is STABLE in "No matches found" state — no re-render in progress. The CDP MismatchedInputException only fires during active re-renders (e.g. right after a set/variant is created+selected). A settled search state doesn't trigger it.

**Confirmed passing:** `cards-parallel-custom` run on 2026-06-09, attempt 4 (after 3 failed attempts diagnosed the root cause).

**How to apply:** Any time `util-drill-to-custom.yaml` adds a new custom sport via the search path, use this sequence. The pattern appears in the "not found in search → not visible Years" sub-branch of Level 1.
