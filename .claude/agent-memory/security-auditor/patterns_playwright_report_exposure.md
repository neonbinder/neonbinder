---
name: patterns-playwright-report-exposure
description: What a Playwright CI report actually publishes - blob/HTML reports embed every path attachment (error-context ARIA snapshots with input values, password fields included), so a glob on results/ does not scope the artifact; plus the MCP output dir and the host-guard shape
metadata:
  type: project
---

Rule: when a workflow claims "only PNGs are uploaded", check the REPORTER
output dir too. Playwright's `blob` reporter copies every attachment that has
a `path` (failure screenshots, `error-context.md`, anything `testInfo.attach`
wrote to disk) into `resources/` inside the blob zip, and inlines `body`
attachments; `merge-reports --reporter=html` copies them again into
`html/data/`. An `upload-artifact` path list of `report/` plus
`results/**/*.png` therefore still publishes error-context. (Verified in the
1.63 source: BlobReporter `_serializeAttachments`, NEO-341.)

**Why it matters:** `error-context.md` carries a page snapshot from
`page.ariaSnapshot({mode:"ai"})`, and the aria tree emits `element.value` for
every input/textarea except checkbox/radio/file. `<input type=password>` maps
to role `textbox`, so a typed password appears in PLAINTEXT, unlike a
screenshot, which masks it. Any one-time secret shown on screen (a freshly
created API key in a dialog) is captured by both channels.

**How to apply:**
- `PLAYWRIGHT_NO_COPY_PROMPT=1` (worker env) is the only switch that drops the
  page snapshot; error-context then holds just the error + code frame. There
  is no config option for it in 1.63.
- If snapshots are kept (diagnostic parity with screenshots), require: no real
  secret ever typed into a field (seed server-side), and any spec that renders
  a live one-time secret blanks the page (`goto("about:blank")` in a catch)
  before rethrowing, since the failure screenshot is taken before afterEach.
- Traces: off in CI (they record network incl. Clerk testing tokens).
- `axe` attachments: check node HTML is stripped (selectors + failureSummary
  are fine).
- The Playwright test MCP server writes screenshots/snapshots to
  `.playwright-mcp/` under its cwd/workspace (the project testDir). Check it,
  `test-results/` and `playwright-report/` are gitignored anywhere in the tree.
- A `*.vercel.app` case-glob on a sed-extracted host is bypassable with a
  query/fragment (`https://evil.example?x=.vercel.app` keeps no `/`), and the
  namespace is publicly registrable anyway; require a full-URL regex anchored on
  the team's own suffix.

Related: [[patterns_testing_endpoint_gate]], [[patterns_neo172_machine_auth]].
