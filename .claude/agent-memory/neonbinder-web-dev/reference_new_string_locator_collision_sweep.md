---
name: reference-new-string-locator-collision-sweep
description: How to prove a new user-facing (incl. sr-only) string cannot satisfy an existing Playwright getByText/getByRole name locator — Playwright name/text matching is a case-insensitive SUBSTRING, so grep the specs for the new string's words and check which page each hit runs on
metadata:
  type: reference
---

Before shipping a new string (live-region copy, labels, sr-only text), sweep the specs rather than eyeballing. Playwright string `name`/`text` matching is a
case-insensitive SUBSTRING unless `exact: true`, and sr-only text counts as visible,
so new copy can make an existing `getByText("...")` resolve to two elements (a
strict-mode error) or match the wrong one.

1. `grep -rn -o -E "(getByText|getByRole|getByLabel|getByPlaceholder|getByTitle)\([^)]*\)" apps/web/playwright/tests apps/web/playwright/support > patterns.txt`
2. Test the candidate strings against each pattern (substring, case-insensitive, or the regex as written).
3. For each hit, read the spec's `signIn`/navigation to see which page the step runs on: a hit on a page that never renders the component is not a collision.

**Why:** loose patterns such as `/matches/` exist (the Players admin counter); NEO-224's
per-column "N matches" sr-only region would have matched them had they run on the set
builder. They don't (all run on `/admin/players`), but only the page check proves it.

**How to apply:** run it whenever adding copy to a screen specs touch; re-run at the
end of a round if the E2E author is editing specs concurrently, and tell the
coordinator which locators need `exact: true`. Related: [[interactive-controls-carry-no-dom-id]].
