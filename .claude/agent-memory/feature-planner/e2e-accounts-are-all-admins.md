---
name: e2e-accounts-are-all-admins
description: Every Playwright account is an admin, so an admin-only block that lists other users' rows (a crew queue) shows on every real screen suite-wide; non-admin rendering is unit-only
metadata:
  type: project
---

Every E2E account (workers 0-11, dedicated `account=` keys) signs in as an admin: the card-request specs play collector and admin on one account. There is no non-admin account to sign in as.

**Why:** an admin-only section that lists ALL users' open rows (e.g. a dashboard "from collectors" queue, NEO-536) is drawn on every real-dashboard spec whenever any other worker has a row open, so it appears and disappears under unrelated specs and their axe checks.

**How to apply:** in a plan that adds such a block, (1) never let it change section order rules other specs assert, (2) scope its accessible names so page-level locators in other specs cannot collide, (3) make the new spec find its own row by a minted token (a note or label), never by position or count, (4) state that the non-admin rendering is proven by component tests only, and disclose it in the PR. A real `numberMismatch` held-back card is not reachable through the product (NEO-458 spec header); the sync-record seed (`seedMyTestSync`) is the fixture for it. Related: [[seller-specs-race-background-drains]], [[aria-names-and-roles-are-the-spec-handles]].
