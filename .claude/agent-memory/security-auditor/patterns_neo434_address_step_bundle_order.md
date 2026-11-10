---
name: patterns-neo434-address-step-bundle-order
description: Auditing "X runs before the SDK starts" claims in the SPA, and how to leak-check a real production bundle safely
metadata:
  type: reference
---

**"First import" is a source-level claim.** An entry chunk's static imports evaluate
before its body, so vendor chunks run ahead of a module that is first in source. Read
the built entry to see the real order, and run a timeline in a browser for the order
of `replaceState` against the first observer, worker, fetch and beacon.

**E2E cannot prove it.** Sentry is off under the Clerk testing flag, and that flag
compiles the init out of a preview build, so an order check has to build with it off.

**Real-bundle leak check**
- Build outside the tree with an empty `envDir`. `vite.config.ts` loads `.env*` from
  the working directory, and a plain `vite build` can upload source maps with a token.
- Stub the envelope endpoints, and decompress recordings before searching them.
- Set a non-headless user agent and `webdriver` false, or PostHog's bot filter hides
  events and the check passes on nothing.
- Keep a control that the raw navigation entry still holds the value. That entry also
  means the address step does not retire the scrub pass.
