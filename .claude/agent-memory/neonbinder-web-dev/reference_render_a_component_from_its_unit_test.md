---
name: reference-render-a-component-from-its-unit-test
description: Screenshot a dialog or drawer the local backend cannot serve by dumping its unit test's happy-dom markup and rendering it with the app's real CSS — no file added to the worktree
metadata:
  type: reference
---

When a screen cannot be reached live (the dev Convex lacks a function the branch
calls, or reaching it needs a write such as a staged review batch), its existing
unit test already renders it with mocks. Reuse that render instead of building a
harness page:

1. A scratch vitest config (outside the repo) with `root` = apps/web, the
   `components` project's include, both guard setup files, plus one extra setup
   file whose `afterEach` writes `document.body.innerHTML` to a file named by
   `expect.getState().currentTestName`.
2. Set `sequence: { hooks: "list" }` in that config. The default runs after-hooks
   in reverse, so RTL's auto-cleanup empties the body before your dump runs and
   every file comes out 0 bytes.
3. Render each dump in Playwright with `page.setContent`: inline the CSS fetched
   from a running Vite (`/app/globals.css?direct` and
   `/node_modules/@radix-ui/themes/styles.css?direct`), wrap the body in a
   `.radix-themes` root div, and set `<html data-theme>` per mode.

Mocked child pickers render as stub text, so the shot shows the component's own
chrome, not its children. Related: [[reference-convex-free-page-harness]] (a
whole page behind ProtectedLayout) and [[reference-local-screenshot-script-gotchas]].
