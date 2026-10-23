---
name: prove-a-theme-by-painted-colour
description: How to assert light/dark mode perceivably (banner background + heading colour via toHaveCSS), the pre-mount false positive after a reload, and what cannot be proven without the root attribute
metadata:
  type: patterns
---

Prove a theme mode by what is painted, not `<html data-theme>`: `support/theme.ts`
(`expectLook`, `expectPageLook`) checks the `banner` landmark's `background-color`
(the page colour) and a heading's `color`. `main` is transparent on the signed-in
layout (only the demo paints it), so do not use it.

**Why:** the root attribute has no perceivable handle (no role, no CSS selector, no
evaluate); colours are what the user sees.

**How to apply:**
- After a reload the inline pre-paint script has already set the saved mode, so a colour
  assertion can pass BEFORE React mounts and then flip (a signed-in page re-resolves from
  the profile, which outranks localStorage). Gate on a mounted control first
  (`toBeChecked` on the radio) and prove "saved to the profile" from a second
  `browser.newContext` carrying only the session cookies (`storageState({cookies, origins: []})`)
  built from the `baseURL`/`viewport`/`isMobile`/... fixtures.
- "No flash before mount" has no perceivable handle; it needs the root attribute at
  `waitUntil: "commit"`, so it is a report-to-coordinator gap, not a workaround.
- Signed in with no saved theme resolves to System, so System/emulateMedia steps and axe in
  both modes can run on a backend that lacks the save mutation.
- Mobile hides the app nav behind `Open menu` -> dialog `Menu`; branch on `isMobile`.
