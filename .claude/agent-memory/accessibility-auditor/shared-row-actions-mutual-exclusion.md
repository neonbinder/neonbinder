---
name: shared-row-actions-mutual-exclusion
description: Two independent per-row async actions that share ONE role=status live region and refocus the same heading must cross-disable each other, or a race silently drops an announcement (NEO-121)
metadata:
  type: project
---

## Pattern: one row, two buttons, one live region

`/print/labels` (`apps/web/app/print/labels/page.tsx`) grew a second per-row
async action ("Check for new scans", NEO-121) alongside the pre-existing
Reprint button (NEO-213). Both:

- write their result into the SAME `role="status" aria-live="polite"` element
  for that row (`statuses[row._id]`), by design — the code comment says so
  explicitly ("shared with Reprint failures").
- call `headingRefs.current.get(row._id)?.focus()` in their `finally` block,
  to restore focus after their own button is blurred by going `disabled`.

The bug: each button was only disabled by **its own** in-flight flag
(`disabled={checking}` / `disabled={busy}`), not by the other's. Nothing
stopped a user from firing both for the same row at once. Whichever settled
last won `statuses[row._id]` outright — e.g. a Reprint failure ("This label
expired…") silently overwritten by a concurrent Check's "No new scans yet."
before a screen reader ever got to announce it. This is a WCAG 4.1.3 (Status
Messages) defect: an important, seller-actionable message can be lost with no
trace, not just delayed.

**Fix:** cross-disable — `disabled={checking || busy}` on the Check button,
`disabled={busy || checking}` on the Reprint button. Once only one of the
two row-scoped async actions can ever be in flight at a time, the shared live
region and the shared refocus target are both safe by construction, and no
new region/refs are needed.

**General rule for this codebase:** whenever a row (or any single UI unit)
funnels more than one async action into one shared live region and/or one
shared post-action focus target, audit whether the *triggers* are mutually
exclusive, not just whether each trigger disables itself. Two independently-
disabled buttons feeding one shared announcement channel is the shape of this
bug — look for it whenever a page adds a second action to a row/card that
already had one wired the NEO-213 way (busy state → disable → live region →
refocus heading).

Regression test pattern (see `page.test.tsx`, `"blocks a check while that
row's reprint is in flight, and vice versa"`): hold one action's promise open
with a manually-released resolver, assert the OTHER row-scoped button is
`disabled` even though its own busy flag is false, release, assert it
re-enables. Do this in both directions.

## Related, deliberately NOT flagged as a defect: non-unique per-row accessible names

Every per-row control's accessible name is built from `recipient =
row.toAddress.name || "this label"` (Reprint, Check-for-scans, the scans
disclosure toggle, TrackingCode's Copy button). Two purchases to the same
buyer produce IDENTICAL accessible names on two different rows. This is
**pre-existing since NEO-213** (the Reprint button already had this shape),
and the test suite documents it explicitly as known/accepted rather than a
regression (`page.test.tsx` comment: "the row's copy button is also named
after the recipient, so a bare /jane buyer/ matches two controls" — tests
disambiguate by matching the FULL busy-state label, e.g. "Reprinting the
label for jane buyer", instead of assuming uniqueness). NEO-121 followed the
same established convention for its two new controls rather than introducing
a new one. Worth a future global fix (append tracking code or purchased-time
to disambiguate) but out of scope for a single-ticket audit — flag as a Minor
carried-forward limitation, not a new defect, unless the ticket you're
auditing is the one meant to fix row identity site-wide.

## Target size fix convention already established in this codebase

`components/modules/TrackingCode.tsx`'s Copy button uses `p-2 -m-2` on an
inline text-sized button: padding grows the click/tap target, the equal
negative margin cancels the layout impact, so a ~20px-tall text link becomes
a ~36px hit area with no visual shift. Reuse this exact pattern (`p-2 -m-2`)
for any new inline text-styled button/link control that is a WCAG 2.5.8
(Target Size, 24×24 CSS px minimum) candidate — found and applied to the
"Show all scans (N)" disclosure toggle in NEO-121, which had no padding at
all (bare `text-sm underline`, ~20px tall, standalone in its own div — not
inline in a sentence, so the inline-text exception doesn't apply).
