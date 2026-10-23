---
name: system-theme-makes-os-colour-scheme-a-test-input
description: Once the app follows prefers-color-scheme (NEO-356 Light/Dark/System), the harness's colorScheme is a suite-wide input; pin it in playwright.config, let only theme specs emulateMedia, and make a spec that stores a preference on its worker account restore it
metadata:
  type: project
---

A System-default theme turns the browser's `prefers-color-scheme` into an
input to every E2E spec. Plan the pin in `playwright.config.ts`
(`use.colorScheme: "dark"` on both e2e projects), never per spec; only the
theme specs call `page.emulateMedia`. A spec that writes a stored theme
preference to its worker's account must end on System (the seed reset only
clears it at the pass boundary), or the rest of that worker's shard renders
light. Also plan: GUIDE.md's "never force a colour scheme" line is rewritten
in the same PR, and the DOM-root attribute assert goes through
`expect.poll(page.evaluate(...))`, not a CSS locator.

**Why:** NEO-356 planning (2026-10-22). The suite had relied on `.dark` on
`<html>` making the OS setting irrelevant; a System default removes that.

**How to apply:** any theming, colour-scheme or per-user appearance feature.
Related: [[e2e-branches-on-operator-flags-via-env-not-visibility]].
