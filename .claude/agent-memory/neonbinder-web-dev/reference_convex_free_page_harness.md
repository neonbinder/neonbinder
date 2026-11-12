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

A page that reads `window.location.search` (the Print Shop's prefill) never
sees MemoryRouter's location: use `<BrowserRouter basename="/app/<path>/zz-harness.html">`
and `history.replaceState(null, "", BASE + start)` before render, so in-app
Links change the real URL. One harness can then mount several routes,
Convex-backed ones under the 3-method fake client from
[[visual-harness-fake-convex-client]] (PrintLayout's four queries return null/[]).

**Out-of-tree variant (NEO-522, shared worktree):** keep every harness file in
the scratchpad, none beside the page. A Vite config there with `root: <apps/web>`,
plugins imported by ABSOLUTE path (`<apps/web>/node_modules/vite/dist/node/index.js`,
`@vitejs/plugin-react/dist/index.js`, `@tailwindcss/vite/dist/index.mjs`; bare
names do not resolve from the scratchpad), `resolve.alias` `/^\/src\/main\.tsx$/`
→ the scratch `harness.tsx` (index.html's entry then mounts the harness) plus
`"@"` → apps/web, and `server.fs.allow` both dirs. Symlink
`<scratch>/node_modules` → apps/web's, or the harness's own `react` import fails.
A second config rooted at `main/apps/web` (its own node_modules symlink, or two
Reacts) gives a before/after baseline at the same widths. For table layouts,
measure `scrollWidth` and each `th` width at 768/800/1024/1280: `w-full` on one
auto-layout column squeezes every other column to min-content.

**Measure against the real column, not the viewport (NEO-522).** A harness
without binder-layout's wrappers lies about width: from `lg` (1024) `main`
reserves `lg:pr-[170px]` for the fixed right-hand side nav, and the inner
`max-w-6xl p-6` takes 48 more, so the content column is `min(1152, vw-170)-48`
(806 at 1024, 1062 at 1280), but `vw-48` below lg (852 at 900). A desktop at
1024 has LESS room than a 900px tablet. A table sized with `lg:` classes
overflowed under the side nav (the nav then intercepts clicks on the
right-hand columns in E2E). Fix: wrap the table in `@container` and size it
with container variants (`@min-[62rem]:text-[1.75rem]`); Tailwind 4 emits
those after the `md:` ones, so they win when both match. Keep the
phone/columns switch on the viewport (`md:`), since the E2E projects key on it.
