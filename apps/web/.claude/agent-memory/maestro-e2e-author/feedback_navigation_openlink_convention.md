---
name: navigation-openlink-convention
description: Prefer openLink over tapping a link to navigate — tap-triggered navigation intermittently crashes maestro-web (upstream #2944)
metadata:
  type: feedback
---

# Navigation: `openLink`, not link taps (maestro-web #2944)

## The bug
`tapOn` an element that triggers a page navigation can crash maestro-web
**intermittently**. After every tap, maestro-web re-parses the DOM in
`CdpWebDriver` to confirm the UI settled; if the tap kicked off a client-side
navigation that tears the page down mid-parse, an **unguarded cast** throws:
- their signature: `ClassCastException: LinkedHashMap cannot be cast to String`
- our signature: `null cannot be cast to non-null type kotlin.Int`
  (preceded by `CdpWebDriver: Failed to execute JS` / `MismatchedInputException:
  No content to map due to end-of-input`)

Surfaced in JUnit as a bare **"Unknown error"**. It's a RACE → passes most of
the time, fails intermittently. `profile/fill-profile-data` passed 7/8 overnight
then crashed on `tapOn "View your profile"` (CI run 27905676068). NOT a product
bug; NOT something `waitToSettleTimeoutMs` can tune (the post-tap settle is baked
into `hierarchyBasedTap`).

Upstream: **mobile-dev-inc/maestro#2944** (OPEN as of 2026-06; root-caused to
unguarded `as String`/cast in `parseDomAsTreeNodes`). Watch for the fix; once we
bump maestro past it, real click-navigation becomes reliable.

## Convention (apply by default)
- **Navigate to reach a page** (the common case — "be on /u/x to test /u/x"):
  use `openLink: ${APP_URL || "http://localhost:3000"}/path`. Deterministic,
  faster, no post-tap DOM-parse race. This is already the suite's dominant
  pattern (e.g. `set-selector/custom-entry-survives-resync` navigates with
  openLink).
- **Verify a link is wired correctly:** `assertVisible` the link's href/text
  (maestro surfaces anchor hrefs as text — that's how fill-profile-data checks
  the eBay/SportLots links), THEN `openLink` to the target to prove it renders.
  Covers "points to right URL" + "target works" without the racy click.
- **Only `tapOn` to navigate when the click HANDLER has real logic** (router
  guards, side effects, modal open) — there the click is the behaviour under
  test; accept retry / mitigate.

## Applied
`profile/fill-profile-data.yaml` (2026-06-21): replaced
`tapOn "View your profile at /u/${TEST_USERNAME}"` with
`openLink ${APP_URL}/u/${TEST_USERNAME}`; kept line-127 `assertVisible` of the
link text + all 35 post-navigation assertions. Validated 5/5 → green. Documented
in `.maestro/README.md` ("Navigation in flows").
