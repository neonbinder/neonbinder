---
name: column-sync-failed-hides-the-empty-line
description: NEO-450 — a set-builder column whose sync failed hides its "No <x> available…" line and shows only a role=alert sentence; waits must wake on columnSyncError; derive copy regexes from the product builder via a marker split
metadata:
  type: project
---

Since NEO-450 a set-builder column whose own sync failed shows ONLY the
alert `Couldn't sync <column> — please try again.` (role `alert`, text from
`columnSyncFailedMessage` in `components/SetSelector/column-sync-failed.ts`,
React-free so specs import it). The idle "No <x> available. Sync from
marketplaces to populate." line is hidden meanwhile, so:

- A wait that settles on the idle line or the rows must also wake on
  `columnSyncError(page, column)` (support/set-builder.ts), then assert it
  hidden with a message, so a failure reds by name instead of as a timeout.
- `empty.toBeHidden()` is no longer proof rows landed: pair it with the
  alert hidden (see [[negative-asserts-pass-on-a-dead-page]]).
- `.or()` with the alert needs `.first()`: the alert may sit beside rows a
  sync stored earlier (strict mode).

**Why:** the old `/Couldn.t sync options/` page check would have silently
matched nothing after the copy change.

**How to apply:** to match "any column" copy, build the regex from the
builder: `builder("\u0001").split("\u0001")` gives head/tail, escape both,
join with `.+` (setup.spec.ts `ANY_COLUMN_SYNC_FAILED`); never hand-copy the
sentence. Use `toHaveCount(0)` for page-wide absence (two failed columns
would make `toBeHidden` a strict-mode error).
