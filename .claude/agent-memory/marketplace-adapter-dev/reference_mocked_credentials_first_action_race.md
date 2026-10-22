---
name: mocked-credentials-first-action-race
description: A convex-test file that vi.mocks ./credentials and drives previewCardChecklist/fetchCardChecklist with the REAL adapters gets the real getSiteToken on its first action only; pre-import the mocked module in beforeAll
metadata:
  type: reference
---

Seen on a root convex test that mocked `./credentials` (token for any site)
and ran `previewCardChecklist` with the real BSC and SportLots adapters,
`fetch` routed by URL: whichever test ran FIRST in the file failed. Its log
said `Failed to retrieve token for buysportscards` with a
`BrowserServiceOutdatedError` (the real `getSiteToken` asked the stubbed
`/health`, which answered `{}`). Every later test in the file got the mock.
A file that calls `fetchBscChecklist` directly as its first action (the
cross-adapter parity tests) does not show it.

**How to apply:** add `beforeAll(async () => { await import("./credentials"); })`
beside the `vi.mock`. Running one test alone with `-t` reproduces the failure
(that test is then first). When a red test's log names the real credentials
path despite a mock, suspect this before the code under test.
Related: [[cross-adapter-parity-test]], [[convex-test-needs-the-modules-arg]].
