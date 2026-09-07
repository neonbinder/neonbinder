---
name: admin-teams-selects-are-unreachable
description: "The League and Franchise dropdowns on /admin/teams cannot be driven by Maestro at all — three <select>s on the page and maestro-web resolves an <option> tap by index against the FIRST one in the document. Franchise membership (NEO-254) therefore has NO E2E path."
metadata:
  type: reference
---

# `/admin/teams` detail-panel dropdowns are untappable

Verified 2026-09-06 by reading `maestro-web.js` out of
`~/.maestro/lib/maestro-client.jar` (`getSyntheticNodeBounds`,
`maestro.tapOnSyntheticElement`) — the mechanism is in
[[native-select-option-taps]]; this note is the *consequence* on one screen.

An `<option>` gets synthetic bounds from **its index inside its own parent
only** (`x=100000, y=100000+idx*20`). `tapOnSyntheticElement` then scans
`document.querySelectorAll('option')` in DOCUMENT ORDER and acts on the FIRST
option whose bounds contain the point. So a select is reachable only when every
select ABOVE it in the DOM has fewer options than the target index.

`/admin/teams` renders three, in this order:

| # | select | options |
|---|---|---|
| 1 | `league-filter` (list header, always mounted) | `All leagues`, `No league`, + every league in the deployment |
| 2 | `team-league` (detail) | `— none —`, + leagues in the sport, `+ Add a new league…` |
| 3 | `team-franchise` (detail, NEO-254) | `— none —`, + franchises in the sport, `+ Start a new franchise…` |

Reaching #3 would need more franchises in one sport than there are leagues in
the whole deployment. A flow cannot arrange that, and concurrent workers move
both numbers. **So #2 and #3 are unreachable, permanently, as written.** This is
why `team-management-edit-a-team.yaml` has never touched the League dropdown.

## What that costs

`<select id="team-franchise">` is the **only** control in the product that sets
`teams.franchiseId`. `/admin/franchises` can only REMOVE a team from a thread,
and `NewTeamForm` (the New Team dialog + the wizard's New Team step) has no
franchise field. So franchise MEMBERSHIP, the dated thread rail and the
"Remove <team>" button have no E2E path and are carried by
`FranchiseManagement.test.tsx` / `convex/franchises.test.ts` alone.
`admin-franchises-start-and-rename.yaml` covers everything else and documents
this in its header.

## The fix is app work, not flow work

`components/SetSelector/NewTeamForm.tsx` already documents this exact trap in
its own header and is built out of `role="radio"` pills *because of it* ("A
dropdown here would be untappable by every flow that has to use it"). Giving
`team-franchise` (and `team-league`) that same pill/radiogroup shape makes them
tappable. Do not paper over it in a flow, and do not reach for select typeahead
via `inputText` — `pressKey` maps only ENTER and BACK_SPACE on web
(`WebDriver.mapToSeleniumKey`), so there is no arrow-key fallback either.
