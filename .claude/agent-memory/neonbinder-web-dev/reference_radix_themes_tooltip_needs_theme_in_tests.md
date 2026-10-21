---
name: radix-themes-tooltip-needs-theme-in-tests
description: Radix Themes Tooltip throws "must be used within TooltipProvider" outside <Theme> (component tests render without it); its trigger's aria-describedby is overridable; headless Playwright .focus() does not open it, Tab does
metadata:
  type: reference
---

Radix Themes `Tooltip` (`@radix-ui/themes`) gets its `TooltipProvider` from the root `<Theme>` (delay 200ms). The app always has one (`src/main.tsx`), but component tests render pages bare, so the first Tooltip in a tree turns every test that renders it into `Tooltip must be used within TooltipProvider`. Fix in the tests: wrap the render in `<Theme>` (`import { Theme } from "@radix-ui/themes"`). Do not import the `radix-ui` primitive package for a Provider: it is only a transitive dep of Themes, not declared in package.json.

Two behaviours worth knowing:
- The trigger is `asChild`, and Slot merges the CHILD's props over the trigger's, so a child with an explicit `aria-describedby` (even `undefined`) wins over the tooltip's own. Use that to stop a tooltip that repeats the accessible name from being announced twice; pass `aria-label` to the Content to announce only the extra text instead. A dnd-kit handle's own describedby (drag instructions) survives for the same reason.
- Radix ignores touch pointers and a focus that follows a pointer-down, so a tap never opens it. In headless Playwright, `locator.focus()` did NOT open it (data-state stayed closed); a real `Tab` did. happy-dom `el.focus()` inside `act` does open it.

Related: [[reference_radix_button_outside_theme_portal]] (Themes styling needs the Theme root too).
