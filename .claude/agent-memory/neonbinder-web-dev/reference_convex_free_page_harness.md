---
name: convex-free-page-harness
description: To screenshot and click through a Convex-free page behind ProtectedLayout (no Clerk sign-in), serve a throwaway harness.html + harness.tsx beside it from a spare-port Vite and drive it with apps/web's own Playwright
metadata:
  type: reference
---

Worked on NEO-350 (collection prototypes on fake data, routes under ProtectedLayout):

1. Beside the page, write `zz-harness.html` (`<html class="dark">`, `#root`,
   `<script type="module" src="./zz-harness.tsx">`) and `zz-harness.tsx`
   importing `@/app/globals.css` then `@radix-ui/themes/styles.css`, rendering
   `<Theme appearance="dark" accentColor="green" grayColor="sage" radius="large">`
   around `<MemoryRouter initialEntries={[start]}>` with the page's `<Route>`
   and binder-layout's `main lg:pr-[170px]` / `max-w-6xl mx-auto p-6` wrappers.
2. `VITE_DEV_DISABLE_HTTPS=1 npx vite --port <spare> --strictPort` in the
   background; open `/app/<path>/zz-harness.html?start=<encoded route>`.
3. Script in the scratchpad: `createRequire(apps/web/package.json)("playwright")`,
   real role/label locators, `page.on("pageerror"|"console")` to catch errors,
   screenshots at 1024x629 and 390x844. Doubles as a keyboard/undo smoke test.
4. Delete both harness files and kill Vite before reporting.

Only for pages with no Convex/Clerk hooks; for those see
[[visual-harness-fake-convex-client]]. Reading `aria-current` straight after a
Link click shows the OLD tab: router navigation commits in a transition
([[reference_router_navigation_is_a_transition]]); wait a tick.
