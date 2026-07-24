# design-sync notes — neonbinder apps/web

## Scope decision

Synced `components/primitives/` only (23 components, clean barrel `components/primitives/index.ts`,
zero Convex/backend coupling). `components/modules/` is explicitly OUT of scope — several files
call Convex `useQuery`/`useMutation` directly and aren't portable design-system pieces (they're
app-specific compositions, not reusable primitives). Decided with the user 2026-07-22.

## No prior library build

`apps/web` is a Vite SPA (`private: true`, no `main`/`module`/`exports`) — not a publishable
package, no Storybook. Added a dedicated build in NEO-93 (PR #84,
`neonbinder/neonbinder`) purely to give design-sync a real dist + `.d.ts` entry:

- `vite.lib.config.ts` — library-mode Vite build, entry `components/primitives/index.ts`,
  output `dist-design-system/`, externals `react`/`react-dom`/`react/jsx-runtime`/`react-router`.
  `publicDir: false` is required — Vite's default publicDir copy pulls in unrelated app assets
  (favicons, logos, convex.svg) into the library output otherwise.
- `tsconfig.lib.json` — extends the app's `tsconfig.json`, flips `noEmit`/`isolatedModules` off,
  `declaration`/`emitDeclarationOnly` on, scoped to `components/primitives/**`.
- `npm run build:design-system` runs both. Does NOT touch the existing `build` (full SPA) script.

Confirmed this doesn't affect the main app build (`npm run build` still produces the normal SPA
`dist/` unchanged).

## Styling

No dedicated design-system stylesheet — components are pure Tailwind utility classes against the
app-wide `tailwind.config.js` (custom neon color tokens: `neon-green`, `neon-pink`, `neon-yellow`,
`neon-blue`, `neon-purple`, `neon-orange`) plus a couple of hand-written classes (`.neon-header`
etc.) in `app/globals.css`.

**`cssEntry` is NOT `app/globals.css` directly** — that file is Tailwind v4 *source*
(`@import "tailwindcss"` + `@config "../tailwind.config.js"`), and design-sync scrapes a
*compiled* stylesheet. Pointing `cssEntry` straight at the source produces
`[CSS_IMPORT_MISSING] _ds_bundle.css @imports "tailwindcss" which doesn't exist`. Fix: a second,
dedicated Vite config compiles it —

- `vite.lib.css.config.ts` — uses the `@tailwindcss/vite` plugin (already a devDependency) against
  a trivial generated entry (`.design-sync/.cache/css-entry.ts`, just `import "../../app/globals.css"`)
  and emits a real compiled stylesheet to `dist-design-system/neonbinder.css` (Vite names lib-mode
  CSS output after `package.json` `name` when `cssCodeSplit: false` — not configurable via
  `fileName`, that option only names the JS entry).
- `build:design-system` (in `package.json`) chains: JS lib build → `tsc` for `.d.ts` → generate
  the css-entry.ts → this CSS build. `cfg.cssEntry` = `"dist-design-system/neonbinder.css"`.

This compiled file is what actually resolves — real oklch color values, real neon-token
utility classes, the `Neon` `@font-face` rule intact.

## Fonts

- `Neon` custom font — self-hosted, referenced via `@font-face` in `app/globals.css` with
  `url('/Neon.ttf')` (root-relative, served from `public/`). Wired via `cfg.extraFonts:
  ["public/Neon.ttf"]` since the root-relative URL doesn't resolve on its own once copied.
- `Lexend` (body sans) loads via a remote Google Fonts `@import` in `globals.css` —
  `[FONT_REMOTE]`, informational only, no action needed (loads at runtime).

## Known component quirks (found authoring previews)

- **Accordion / NavigationMenuContent — open/expanded state is interaction-only.** Neither has a
  controlled or `defaultOpen`-style prop; the relevant `useState` starts closed/`null` with no way
  to preset it, so a static screenshot can only ever show the closed/collapsed state. Not a bug —
  previews for these compose the honest default (collapsed) render only. `Collapsible` is
  different and DOES support `defaultOpen`/`open` — its preview sweeps both states.
- **PullingLogo hard-codes `src="/logo.png"`** (root-relative, no override prop) — always renders
  as a broken image in an isolated preview sandbox (no `public/` server backing it there). Real,
  permanent constraint of the component, not a defect; graded `good` since sizing/animate/alt-text
  all compose correctly around it.
- **`Link`'s react-router branch can't render in a preview.** `Link` renders react-router's
  `RouterLink` whenever no `onClick` is passed. Wrapping a preview cell in `<MemoryRouter>` does
  NOT fix this: the compiled component bundle (`_ds_bundle.js`) and a preview's own compiled JS
  each bundle their OWN separate copy of react-router (confirmed via grep count in both files) —
  only `react`/`react-dom` get cross-bundle singleton treatment from the design-sync converter
  (`window.React`/`window.ReactDOM`), react-router does not. The Provider and the component's
  context consumer are different module instances, so the panel renders blank with no thrown
  error. This is a structural limit of the design-sync tool itself (documented as the
  "component-private context" residue case), not something fixable via `cfg.provider` or any other
  config here. Fix used: all `Link` preview cells pass `onClick` (a real, fully-supported code path
  of the component) instead of relying on `RouterLink`. Any other component that internally calls
  react-router's `Link`/`NavLink`/`useNavigate` etc. would hit the same wall.
- **RadioButton's checked-state ternary is a no-op** in the source
  (`components/primitives/RadioButton.tsx`) — both branches of `props.checked ? ... : ...` on the
  outer ring render identical classes, so checked/unchecked is distinguished only by the inner dot,
  never the outer ring. Cosmetic, doesn't block grading (the dot reads clearly), left as-is — minor
  enough not to warrant its own ticket, but worth fixing alongside any future RadioButton touch.
- **ScrollListItem's root is `inline-flex`**, not `flex`/`block` — stacking several instances in a
  plain wrapper `<div>` makes them flow horizontally. Wrap consumers in `flex flex-col` (the
  preview does this).
- **Menubar/MenubarItem's plain white/slate styling (no neon tokens) is intentional**, straight
  from the source (`bg-white`, `border-slate-300`, `hover:bg-slate-50`) — not a missed styling
  opportunity if it looks understated next to the neon-heavy components.
- **Checkbox's checked state didn't render the intended slate-900 fill** — `appearance-none` was
  missing on the input, so the browser's native checkbox painted over the custom style in every
  real consumer, not just previews. **Fixed in NEO-94 (PR #85)**, not yet merged as of this sync.
  Until it merges, `Checkbox`'s `Checked`/`WithDescription` preview cells are graded `needs-work`
  (deferred, tracked — not a preview-authoring gap); `Unchecked`/`Disabled` are `good`. Re-run this
  sync after NEO-94 merges to pick up the fix and re-grade to fully `good`.

## Re-sync risks

- The `dist-design-system/` build is gitignored (machine state) — a fresh clone must run
  `npm run build:design-system` before design-sync can pick up the entry. `buildCmd` in
  config.json already tells re-syncs to do this.
- `components/modules/` staying out of scope is a standing decision, not a technical limit —
  if a future primitive migrates in from modules/ (deliberately decoupled from Convex), it should
  land in `components/primitives/` and get picked up automatically; don't special-case it here.
- Neon color tokens live in `tailwind.config.js` as plain JS values, not CSS custom properties —
  if the DS ever migrates to CSS vars, `cssEntry`/`tokensGlob` will need revisiting.
- **Checkbox's `Checked`/`WithDescription` cells are graded `needs-work`, deferred pending NEO-94**
  (PR #85, one-line `appearance-none` fix, open but not merged as of this sync). Re-run
  `package-capture.mjs --components Checkbox --force` after it merges and re-grade — should flip
  straight to `good` with no preview changes needed.
- The `vite.lib.css.config.ts` CSS build depends on `@tailwindcss/vite` already being a
  devDependency of `apps/web` (it is, for the main app's own Tailwind v4 setup) — if that ever
  gets removed/replaced, this build breaks too.
