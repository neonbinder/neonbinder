---
name: read-a-row-name-with-aria-snapshot
description: When a spec must pick a seed row it cannot name in advance, read its accessible name with locator.ariaSnapshot() instead of getAttribute or evaluate
metadata:
  type: feedback
---

To use "the first ordinary row" of a seeded list, locate it with a role + name
regex (`getByRole("button", { name: /^Details for #\S+ .../ }).first()`), then
read the accessible name from `await loc.ariaSnapshot()` (`- button "Details
for #12 First Last"`) and rebuild exact names from it.

**Why:** the name is the perceivable handle; `getAttribute("aria-label")`,
`evaluate` and ids are the under-the-covers hooks the hard rule bans.

**How to apply:** collection/checklist rows whose label embeds the card; then
use `{ name, exact: true }` for every later locator (a bare name is a substring
and "Edit X, Raw" is inside "Edit X, Raw, Near Mint x2"). Scope a search hit's
row by its number span, player span and a sub-line regex, since parallels of the
same card repeat number and player.
