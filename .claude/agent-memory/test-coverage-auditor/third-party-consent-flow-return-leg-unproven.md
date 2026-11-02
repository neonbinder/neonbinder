---
name: third-party-consent-flow-return-leg-unproven
description: Specs that replace an OAuth consent screen with a seed hop prove nothing of the begin/return legs; ask for a drivable return-URL and begin-redirect spec, and watch instant isVisible() branches on server-read controls
metadata:
  type: feedback
---

When a connect flow runs through a third party's consent screen, the E2E replaces it with a seed hop. That leaves the begin leg (button -> authorize URL), the return leg (`?code=&state=` handled, URL cleaned, bad/declined state shown) and every error state (needs-reauth, conflict, refused) with unit coverage only.

**Why:** NEO-415 eBay audit: the live spec connected only by seed hop; the return page and error states had no live proof or axe run.

**How to apply:** Require a small spec that (a) asserts Connect navigates to the provider host without following it (route/waitForURL), (b) opens the return URL with a bogus state and asserts the NB error line, axe, and the cleaned URL. Also flag `if (await x.isVisible())` guarding a control that appears only after a server read: it synchronises nothing, so a slow read silently takes the other branch (GUIDE rule 4 / R2).
