# NEO-356 light mode: migrating a file to colour roles

Working notes for the batches that move the app onto the colour roles. Delete
this file before the NEO-356 PR merges; what stays true moves to DESIGN.md.

## The rule

A component paints with **roles**, never with palette steps. A role is a CSS
variable set twice in `app/theme.css`: once for dark (the app's look before
NEO-356, value for value) and once for light (theme 6, "Trapper Keeper Glo").
`<html data-theme>` is always `light` or `dark`, so a role class is all a
component needs. No `dark:` variant, ever.

`theme/no-raw-palette` (ESLint) enforces this. It bans, in any string or
template literal under `app/`, `components/`, `src/` and `lib/`:

- a gray/slate/zinc/neutral/stone step on a colour utility (`bg-gray-900`,
  `border-t-slate-700`, `hover:text-slate-300`);
- white or black as paint (`text-white`, `bg-black/60`); a black shadow or a
  black gradient stop over a photo is allowed;
- a raw hex in an arbitrary value (`ring-[#00C2FF]`, `hover:bg-[#33e07c]`);
- `dark:` anywhere in a variant chain.

## Your batch's done criterion

1. Migrate the file using the table below.
2. Delete its line from `PENDING` in `scripts/eslint/theme-allowlist.mjs`.
3. `npm run lint` is clean, and `npx vitest run scripts/eslint` passes (it
   fails if a PENDING file is already clean, so a forgotten line is caught).
4. Update unit tests in your area that assert the old class strings.

`node scripts/eslint/scan-theme.mjs` prints every file the rule would still
flag; `node scripts/eslint/scan-theme.mjs --shared` prints the prototype
modules the shipped collection demo imports (those must be migrated; the rest
of `app/collection/prototypes/` is forced dark and permanently allowlisted).

Never add a line to PENDING by hand. A new file starts clean. A genuinely
fixed-colour object (paper, a QR code, a card face, art) goes in `PERMANENT`
with a one-line reason, and needs the coordinator's agreement.

## Mapping table

| From | To | Dark value (unchanged unless noted) |
|---|---|---|
| `bg-background`, `bg-black` | `bg-surface` | #0A0A0A. `bg-black` was #000: a 4% lift, invisible |
| `bg-gray-800` (cards, rows) | `bg-raised` | gray-800 |
| `bg-gray-900` (panels, menus, popovers, lit tab) | `bg-raised-deep` | gray-900 |
| `bg-slate-950` (big sheets, dialogs) | `bg-sheet` | slate-950 |
| `bg-slate-900` (input wells) | `bg-field` | slate-900 |
| `hover:bg-gray-800`, `hover:bg-slate-800` | `hover:bg-hover` | gray-800 (slate-800 shifts slightly) |
| `border-slate-800` (dividers, header rule) | `border-rule` | slate-800 |
| `border-slate-700`, `border-gray-700` (card and panel edges) | `border-rule-strong` | slate-700 (gray-700 near-identical) |
| `border-slate-700` on a **text field** | `border-field-rule` | slate-700; light #757090 for 3:1 |
| `border-slate-500`, `-600`, `border-gray-500` (a control's boundary: checkbox, radio, chip, a field on a card) | `border-control` | slate-500. Was 600 in places: 2.4:1, it lightens to pass 3:1. A purely decorative line is `border-rule-strong` instead |
| `text-white`, `text-slate-100`, `text-gray-100` | `text-ink` | #FFF (slate-100 shifts slightly) |
| `text-slate-200`, `-300`, `text-gray-200`, `-300` | `text-ink-2` | slate-300 |
| `text-slate-400`, `-500`, `text-gray-400`, `-500` | `text-ink-3` | slate-400 (gray-400 is near-identical) |
| page body text that relied on inheritance | `text-foreground` (or nothing) | #EDEDED |
| `text-black` on a neon fill | `text-on-neon-X` | #000 in both modes |
| neon as text (`text-neon-pink`, `text-[#FF2E9A]`) | `text-neon-X-text` | the fill in dark (violet: #B56BFF); deepened to 4.5:1 in light |
| `bg-[#00D558]` etc. | `bg-neon-X` | unchanged |
| `hover:bg-neon-green/85`, `hover:bg-[#33e07c]` | `hover:bg-neon-X-hover` | 85% of the fill; light uses a lighter tint |
| `bg-black/60`, `bg-black/70` scrims | `bg-scrim` | rgb(0 0 0 / .6) |
| `focus(-visible):ring-2 ring-[#00C2FF]` (+ `outline-none`, `ring-offset-*`) | `focus-outline` | 2px cyan outline, 2px out (the approved focus change) |
| `ring-[#00C2FF]` meaning SELECTED (a chosen row, a picked card) | `ring-selection` / `border-selection` | cyan |
| a glow on a selected state (`shadow-[0_0_12px_...]`) | keep the glow for dark if you like, but also give the selected state a line (`ring-2 ring-selection` or a `border-selection`): light has no glows, and selection must never rest on a glow alone | |
| `dark:` pairs (`bg-white dark:bg-gray-800`) | the role of the DARK half | the light halves were never maintained |
| inline `style={{ color: "#FF2E9A" }}` | a role class, or `var(--neon-pink-text)` in the style | |

### Other hues (red, amber, blue, green, ...)

The lint rule does not catch `-red-`/`-amber-`/`-blue-` steps, but most of them
are dark-only: `text-amber-300` on white is unreadable. Map them yourself:

- **Notices** (an info/warning/error/success box): `bg-notice-{info,warn,danger,success}-bg`,
  `text-notice-*-ink`, `border-notice-*-rule`. Dark values are the 900 ground /
  200-300 ink / 700 rule family the app already used most.
- **Destructive** is pink, not red (DESIGN.md: pink means stop). `ErrorAlert`
  uses `bg-neon-pink/10 border-neon-pink text-neon-pink-text`.
- A solid hue with white text that passes in both modes (`bg-red-600 text-white`)
  is fine, but `text-white` is banned: use `text-on-neon-X` only on neon fills;
  otherwise ask the coordinator for a role before inventing one.

## Signatures (apply them explicitly; nothing matches class strings)

| Class | What it does | Where |
|---|---|---|
| `shadow-offset` | light only: a hard 5px 5px 0 cyan offset (green when the element or a child has `data-complete="true"`), and focus sits 4px out. Dark: no change | scoreboards, the set picker's columns (Years / Brands / Sets / Variant Types), sheets, popovers, notices |
| `focus-outline` | 2px focus-colour outline on `:focus-visible` | every focusable thing |
| `binder-tab`, `binder-row` + `tab-hue-X` | the index tabs and mobile menu rows; the lit one is `aria-current="page"` | binder-tabs.tsx, mobile-nav.tsx; DemoChrome's tab (B2) should move to these |
| `pip`, `pip-owned`, `pip-want`, `pip-missing` | the scoreboard pips: dot / thick amber ring / thin ring in light | replace `size-[7px] rounded-full bg-neon-blue shadow-[...]` etc. (B2) |
| `shelf-ledge`, `shelf-ledge-special` | the shelf ledges' colours (violet gradient + lit edge in light) | `.p2-ledge`, `.nb-special-ledge` keep their size; add the class and drop their colours (B2) |
| `text-wordmark` | the Neon Binder wordmark: inherits in dark, brand green in light | headers |
| `outline-spot` (`--spot`) | the "found it" ring colour | `.mc-spot` in cards.css: `outline: 3px solid var(--spot)` (B2) |

## Components

- `BrandMark` (primitives): the header logo. Dark is the neon PNG; light is the
  single-colour Mark (`public/logo-mark.svg`) in the brand green. Use it for
  every `<img src="/logo-120.png">` in a header (the marketing pages, B5).
- `ForceDark` (primitives): forces dark while mounted (the NEO-350 prototypes,
  B2). Uses the provider's override slot.
- `ModeRadioGroup` (primitives): the Light / Dark / System picker.
- `useTheme()` (`src/theme/ThemeProvider.tsx`): `{ preference, setPreference,
  mode, setOverride, setProfilePreference }`. The collection demo toggle (B2)
  uses `setOverride`, never `setPreference`.
- `src/theme/tokens.ts`: the roles as data, for code that computes with a colour
  (team livery contrast: `teamTextColor(team, surfaceHex("raised", mode))`).
  `tokens.test.tsx` fails if it drifts from theme.css.
- Radix `<Theme>` nested with no props inherits the mode (portals included).
  A nested `<Theme appearance="dark">` pins dark: `LabelDesigner.tsx` (B2) has
  one; decide whether that object should stay dark.
- `clerkAppearance(mode)` skins every Clerk widget from `<ClerkProvider>`.
  `app/profile/api-keys` (B5) still passes `clerkNeonAppearance` (dark) to
  `<APIKeys>`: drop the prop so it follows the mode.

## Tests

- E2E runs in Playwright's default LIGHT colour scheme. With System as the
  default, the suite renders light until `use.colorScheme: "dark"` is pinned
  in playwright.config.ts (the E2E author's task).
- A unit test that asserted a palette class (`bg-slate-900`, an inline `#00D558`)
  should assert the role instead. NeonButton's inline style is now
  `var(--neon-green)` etc.
