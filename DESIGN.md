---
name: Neon Binder
description: A collector's binder in two modes — dark pages lit in neon, or bright Trapper Keeper sheets with a hard neon offset.
colors:
  neon-green: "#00D558"
  neon-pink: "#FF2E9A"
  neon-blue: "#00C2FF"
  neon-yellow: "#FFE600"
  neon-orange: "#FF9E00"
  neon-teal: "#00E5C0"
  neon-purple: "#A44AFF"
  neon-red: "#FF2D3D"
  ink-on-neon: "#000000"
  dark-surface: "#0A0A0A"
  dark-raised: "#1E2939"
  dark-raised-deep: "#101828"
  dark-sheet: "#020618"
  dark-field: "#0F172B"
  dark-hover: "#1E2939"
  dark-rule: "#1D293D"
  dark-rule-strong: "#314158"
  dark-control: "#62748E"
  dark-ink: "#FFFFFF"
  dark-ink-2: "#CAD5E2"
  dark-ink-3: "#90A1B9"
  dark-focus: "#00C2FF"
  dark-selection: "#00C2FF"
  dark-neon-purple-text: "#B56BFF"
  dark-neon-pink-text: "#FF40A3"
  dark-neon-red-text: "#FF5560"
  light-surface: "#F7F8FC"
  light-raised: "#FFFFFF"
  light-field: "#FFFFFF"
  light-hover: "#F0F2F9"
  light-rule: "#DDE0EA"
  light-rule-strong: "#BCB9CF"
  light-control: "#757090"
  light-ink: "#18122B"
  light-ink-2: "#322B48"
  light-ink-3: "#57516E"
  light-focus: "#7A2BD9"
  light-selection: "#006DA6"
  light-offset: "#00C2FF"
  light-neon-green-text: "#007A3B"
  light-neon-pink-text: "#C40068"
  light-neon-blue-text: "#006DA6"
  light-neon-yellow-text: "#7A6400"
  light-neon-orange-text: "#9A4D00"
  light-neon-teal-text: "#007060"
  light-neon-purple-text: "#7A2BD9"
  light-neon-red-text: "#C4001F"
  paper: "#FFFFFF"
typography:
  display:
    fontFamily: "Neon, sans-serif"
    fontSize: "30px"
    fontWeight: 400
    lineHeight: 1
  headline:
    fontFamily: "Lexend, Arial, Helvetica, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.33
  title:
    fontFamily: "Lexend, Arial, Helvetica, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.4
  body:
    fontFamily: "Lexend, Arial, Helvetica, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "Lexend, Arial, Helvetica, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.33
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  2xl: "16px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "32px"
components:
  button-primary:
    backgroundColor: "{colors.neon-green}"
    textColor: "{colors.ink-on-neon}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    typography: "{typography.body}"
  button-cancel:
    backgroundColor: "{colors.neon-pink}"
    textColor: "{colors.ink-on-neon}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-destructive:
    backgroundColor: "{colors.neon-red}"
    textColor: "{colors.ink-on-neon}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-secondary:
    backgroundColor: "{colors.neon-blue}"
    textColor: "{colors.ink-on-neon}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  input:
    backgroundColor: "{colors.dark-field}"
    textColor: "{colors.dark-ink}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.dark-raised}"
    textColor: "{colors.dark-ink}"
    rounded: "{rounded.lg}"
    padding: "16px"
  binder-tab-active:
    backgroundColor: "{colors.dark-raised-deep}"
    width: "170px"
---

# Design System: Neon Binder

## Overview

**Creative North Star: "The Neon Binder"**

The app is a binder. Sections are index tabs on the right edge, each with its own ink. Moving between pages turns a page. The work on the pages (checklists, card rows, label fields) sits on quiet surfaces. Neon is the binder's signage: the wordmark, the lit tab, the one button that moves you forward. It is not the wallpaper.

Because the people using it are both cataloguing at a desk and selling at a show table, the working surfaces are crisp and precise rather than playful. Dense lists, `text-sm` body, tight controls, keyboard-first. Personality comes from the wordmark, the neon and the voice of the copy, not from decorating the tools.

**Two modes (NEO-356).** Every screen renders in either:

- **Dark**, the original look: a black room with neon signs in it. Graphite cards, slate wells, glows on what is lit.
- **Light**, theme 6, "Trapper Keeper Glo": white sheets on a cool page, a hard neon offset under each sheet, the binder tab's coloured edge, and no glows (on paper a glow is a smudge).

The person picks Light, Dark or System under Profile → Settings. The choice is saved to their profile and follows them to every device. `<html data-theme>` is always resolved to `light` or `dark`, and every colour follows it through the roles below. A few things are fixed by design whatever the mode: paper (labels, placeholder sheets and QR codes print black on white), card faces and other physical objects, the public storefronts, the binder-tracking night shelf, and the NEO-350 prototypes (`ForceDark`).

**Key Characteristics:**
- Three surface steps per mode: the page, a raised sheet, an input well.
- One neon hue per binder section, shown on the lit tab (a glow in dark, a coloured edge in light).
- Neon fills always carry black ink, in both modes.
- In light, each neon is deepened for use as text, so it reaches 4.5:1 on white.
- The Neon display face appears only in the wordmark.
- Index-tab navigation carries the binder metaphor. Route changes are instant: no page-turn transition.

## Colors

### How colour works

A component paints with **roles**, never with palette steps. Each role is a CSS variable set twice in `apps/web/app/theme.css`: on `:root` (dark, the pre-NEO-356 look value for value) and on `[data-theme="light"]`. Its `@theme inline` block turns every role into a Tailwind colour, so `bg-raised` compiles to `var(--raised)` and follows the mode with no `dark:` variant. Opacity modifiers work (`bg-chip/60`).

`apps/web/src/theme/tokens.ts` mirrors the values as data, for code that computes with a colour (team livery picked for contrast against the surface it sits on, Clerk's appearance). `tokens.test.tsx` fails on any drift and holds the light palette to its contrast promises.

The ESLint rule `theme/no-raw-palette` bans, in `app/`, `components/`, `src/` and `lib/`: any palette step on a colour utility, grey (`bg-gray-900`, `text-slate-300`) or hued (`bg-red-600`, `text-amber-300`, `from-pink-500`), white or black as paint (`text-white`, `bg-black/60`), a raw hex in an arbitrary value (`ring-[#00C2FF]`), and any `dark:` variant. Its only allowlist is `scripts/eslint/theme-allowlist.mjs` → `PERMANENT`: print, the QR code, art, and the forced-dark prototypes, each with a reason.

### Neon (the same fills in both modes)
- **Binder Green** (`neon-green`): the brand and the forward action. Primary buttons, the Dashboard tab, success, the Radix accent (`accentColor="green"`; the green scale's step 9 is this value on sRGB screens, and wide-gamut screens get its Display P3 equivalent).
- **Show-Sign Pink** (`neon-pink`): cancel. Backing out without losing anything: Cancel, Close, Stop, Sign out. Never a decorative accent and never destructive.
- **Tilt Red** (`neon-red`, #FF2D3D): destructive. Delete, Remove, Discard, Abort, Clear, an irreversible confirm, a destructive menu item or × on a chip, and the danger notices. A hot red as bright as the pink, so the family stays lit; the pinball machine's TILT light, the one you don't want to see.
- **Marquee Cyan** (`neon-blue`): secondary buttons, the Collection tab, the light mode's offset shadow.
- **Hazard Yellow** (`neon-yellow`): Inventory; also warnings.
- **Admin Amber** (`neon-orange`): Admin and other gated features.
- **Label Teal** (`neon-teal`): Print Shop, shipping and labels.
- **Profile Violet** (`neon-purple`): Profile.

Each hue plays three roles: the fill (`bg-neon-X`, borders, rings), the hue as text on the page (`text-neon-X-text`), and the ink on the fill (`text-on-neon-X`, black in both modes). In dark the text is the fill itself, except three hues lifted a touch so they reach 4.5:1 on a graphite card: violet #B56BFF (the fill is under 4.5:1), pink #FF40A3 (the fill is 4.27:1) and red #FF5560 (the fill is 3.98:1). In light every hue is deepened to 4.5:1 on white (green #007A3B, pink #C40068, cyan #006DA6, yellow #7A6400, amber #9A4D00, teal #007060, violet #7A2BD9, red #C4001F). A neon fill under the pointer is `bg-neon-X-hover`.

### Surfaces, lines and ink

| Role | Use | Dark | Light |
|---|---|---|---|
| `surface` | the page | #0A0A0A | #F7F8FC |
| `raised` | cards, rows, popovers | #1E2939 (gray-800) | #FFFFFF |
| `raised-deep` | panels, menus, the lit tab | #101828 (gray-900) | #FFFFFF |
| `sheet` | big sheets and dialogs | #020618 (slate-950) | #FFFFFF |
| `field` | input wells | #0F172B (slate-900) | #FFFFFF |
| `hover` | a row on the page under the pointer | #1E2939 | #F0F2F9 |
| `rule` | dividers, the header rule | #1D293D | #DDE0EA |
| `rule-strong` | card and panel edges | #314158 | #BCB9CF |
| `field-rule` | a text field's edge (3:1) | #314158 | #757090 |
| `control` | a control's boundary: checkbox, radio, chip, a field on a card (3:1) | #62748E | #757090 |
| `ink` | body text and headings | #FFFFFF | #18122B |
| `ink-2` | labels | #CAD5E2 | #322B48 |
| `ink-3` | hints, placeholders, quiet text | #90A1B9 | #57516E |
| `focus` | the focus outline | #00C2FF | #7A2BD9 |
| `selection` | a selected thing's line or ring | #00C2FF | #006DA6 |
| `scrim` | behind a dialog | black 60% | ink 40% |

### Rows, chips and neutral buttons

| Role | Use | Dark | Light |
|---|---|---|---|
| `row`, `row-rule`, `row-hover` | a list row that is a tile (the set picker's columns): fill, edge, under the pointer | gray-700, gray-600, gray-600 | #FFFFFF, #BCB9CF, #F0F2F9 |
| `hover-raised` | a hover ON a raised surface: a popover option, an icon button on a card, a collapsed column card | gray-700 | #F0F2F9 |
| `list-hover` | a flat list row on the page under the pointer (the admin master lists) | slate-900 | #F0F2F9 |
| `list-hover-raised` | a checklist row on a raised card under the pointer | gray-700 at 50% | #F0F2F9 |
| `chip` | a neutral tag or filter chip at rest | gray-700 | #E8EAF2 |
| `chip-strong` | one step up: a tag sitting on a row tile, a chip under the pointer | gray-600 | #DDE0EA |
| `button-neutral`, `button-neutral-hover` | a neutral filled button (Sign In on the landing page, a Cancel beside a neon Save), and a disabled button's fill | slate-700, slate-600 | #E8EAF2, #DDE0EA |

`bg-hover` equals `bg-raised` in dark, so never use it for a hover that sits on a raised surface; that is what `hover-raised` is for.

In dark these tiles are light greys, and `ink-3` and the pink, violet and red `-text` hues miss 4.5:1 on all of them (green, cyan and amber miss on the -600 step); in light the one-step-up grey (`chip-strong`, `button-neutral-hover`) misses for green, pink, cyan and yellow text. Quiet text there is `ink-2`, and a destructive hover is a red fill with black ink. `TEXT_NEVER_ON` in `src/theme/tokens.ts` lists every pair; `tokens.test.tsx` holds it to the palette and scans the class strings.

### Panels and washes

| Role | Use | Dark | Light |
|---|---|---|---|
| `panel`, `panel-hover`, `panel-rule` | a quiet tile on the page (the Print Shop's tool cards and summaries): fill, under the pointer, edge. Pair with `shadow-offset` | `field` at 40%, `field`, `rule` | #FFFFFF, #F0F2F9, #BCB9CF |
| `wash-green`, `wash-blue`, `wash-pink` | gradient stops for a promo panel on the public landing page | the neon at 10% | #FFFFFF (a sheet) |
| `wash-rule-green`, `wash-rule-pink` | that panel's edge | the neon at 30% / 40% | #BCB9CF |

### Hued picks and badges

`pick-X`, `pick-X-rule` and `pick-X-ink` for X in pink, blue, green, purple, orange, teal, amber, red and emerald: a fill, its edge, and ink on the fill. Dark is Tailwind's -900 fill, -700 edge and -300 ink; light is a pale tint of the hue, the same -700 edge (3:1 on white and on the tint) and -800 ink (4.5:1 on the tint). The set picker's columns each select in their own hue (pink sports, blue years, green brands, purple sets, orange variant types, teal variants, amber parallels), and the checklist's attribute badges (RC amber, AU purple, Relic pink, SP red, #'d emerald) use the same family: `bg-pick-amber border-pick-amber-rule text-pick-amber-ink`.

### Notices

`notice-{info,warn,danger,success}-{bg,ink,rule}`: a tinted ground, readable ink, a rule. Dark is the -900 ground / -200 to -300 ink / -700 rule family; light is a pale ground with deep ink. Danger is red in both modes: dark's red-900 family, and in light a pale red ground (#FDECEE), deep red ink (#A3001A) and the Tilt Red text hue as its rule (#C4001F).

### State that differs by mode

- **`selection-line`**: transparent in dark, #006DA6 in light. Where a selection is otherwise a fill, a tint alone is a colour-only mark on paper (WCAG 1.4.1), so light adds a line. Applied through the `selection-edge` utility.
- **`--glow`**: 1 in dark, 0 in light. Every glow multiplies its alpha by it (`rgb(0 194 255 / calc(0.6 * var(--glow)))`), as does the black ground that lit neon art sits on. It is a number, not a colour, so it has no Tailwind class.
- **`offset-shadow`**: transparent in dark; cyan in light (green on a complete set).
- **`paper`** / **`on-paper`**: #FFFFFF and #000000 in both modes, for on-screen previews of printed things (the spine sheet, the QR tile). Print documents themselves render in isolated documents and keep literal colours.

### Named Rules
**The Signage Rule.** Neon marks identity and action: the wordmark, the lit tab, the primary button, a status. Working surfaces stay on the neutral roles. If a screen reads as "neon everywhere", something is decorating instead of signalling.

**The Black Ink Rule.** Text on a neon fill is always black, in both modes. White on neon pink is 3.44:1 and on cyan 2.07:1; black is 6.1:1 or better on every hue. One ink keeps the buttons reading as one family.

**The Text Is Not The Fill Rule.** Neon used as text is `text-neon-X-text`, never `text-neon-X`. In dark they match (violet aside); in light the fill is under 2:1 on white.

**The One Hue Per Section Rule.** A section's colour is fixed by its tab (Dashboard green, Collection cyan, Inventory yellow, Admin amber, Print Shop teal, Profile violet). It governs the section's identity: its tab, its headings, its emphasis. Don't borrow another section's hue for that.

**The Own Hue Per Tool Rule.** Inside a section, a set of sibling tools shown side by side (the Print Shop index, the landing page's feature cards) gives each tool's icon, and its hover edge, its own neon hue, no two alike where the set allows. That is the one place a section shows hues other than its own, because there the colour tells the tools apart rather than saying where you are. Pink (cancel) and red (destructive) are never icon hues. Where a tool appears in two such sets it takes the same hue in both where it can: Spine Labels are orange on the Print Shop index and on the landing page.

**The Role Not Step Rule.** Reach for the role that names the job (`hover-raised`, `chip`, `selection-line`), never for a role that happens to have the right value in one mode (`bg-rule-strong` as a hover fill, `bg-ink/10` as a chip). The second one breaks the other mode.

## Typography

**Display Font:** Neon (self-hosted `Neon.ttf`, sans-serif fallback)
**Body Font:** Lexend (Google Fonts, 400/500/600/700 loaded; a metric-matched Arial fallback, `Lexend Fallback`, holds line breaks while it loads). Radix Themes' own system-font stack is overridden on `.radix-themes`, or every screen silently renders in San Francisco / Segoe UI.

**Character:** A glowing tube-sign script for the name, over a wide, very legible geometric sans built for reading. The sign is the only flourish; everything else is Lexend.

### Hierarchy
- **Display** (400, 30px; 20px below 1024px in the app header, and below 640px on the public pages): the "Neon Binder" wordmark only, in `text-wordmark` (inherits in dark, brand green #007A3B in light). It never wraps.
- **Headline** (700, 1.5rem): page titles.
- **Title** (700, 1.25rem): section and card headings. `text-xl` is the most-used heading size.
- **Body** (400, 0.875rem): the working size. `text-sm` is the most-used class in the app.
- **Label** (400, 0.75rem): metadata, badges, helper text. Field labels are `text-sm` in `ink-2`.

### Named Rules
**The One Sign Rule.** The Neon face is the wordmark. It is never used for headings, buttons or body copy.

**The Four Weights Rule.** Lexend runs at 400 (body), 500 (labels, tabs), 600 (card and section titles) and 700 (page headings, numbers). Nothing lighter than 400, nothing heavier than 700. Headings wrap balanced and prose wraps `pretty` by default.

## Layout

The signed-in shell is a sticky top header (the brand mark and wordmark left, account and sign-out right, a 2px `rule` underneath), a main column, and the binder index tabs fixed to the right edge, vertically centred. From `lg` (1024px) up the tabs show; below it they collapse into a slide-in mobile nav behind a menu button. Below `sm` (40rem) the header is not sticky, and from `sm` up `scroll-padding-top: 80px` keeps scrolled-to targets clear of it.

Pages are padded generously (16px header, 32px main) and content runs in narrow measured columns: `max-w-md` for forms and dialogs, `max-w-2xl` for reading and marketing text. Feature grids step 1 → 2 → 3 columns at `md` and `lg`, with counts chosen so no card is orphaned. Spacing follows the 4px Tailwind scale; 8, 16 and 32px are the recurring steps.

## Elevation & Depth

Depth is mostly tonal: `surface` → `raised` → `field`, separated by `rule` borders. Shadows play three roles:

- **Floating layer** (Tailwind `shadow-lg` / `shadow-xl`): dialogs, dropdowns, popovers, in both modes.
- **Neon glow** (dark only): marks "lit", meaning the active binder tab and a few live highlights. Scaled by `--glow`, so it is absent in light.
- **Hard offset** (light only, `shadow-offset`): a 5px 5px 0 cyan shadow, bottom and right, no blur, under scoreboards, the set picker's columns, sheets, popovers and notices. Green when the element or a child carries `data-complete="true"`. The other two edges get a 1px `rule-strong` hairline, left and top, drawn inset so it moves nothing; without it a white sheet on the cool page barely reads as a card. A sheet with its own full border (`border`, `border-2`) skips the hairline rather than doubling its edge. It holds under the pointer too: a `hover:shadow-lg` glow on the same element shows in dark only. Dark keeps whatever shadow the element had.

### Shadow Vocabulary
- **Tab glow** (`0 0 12px 2px <hue>/0.4, inset 0 0 8px <hue>/0.1`): the active binder tab in dark, in its section's hue. Light draws a 4px inset edge in the hue on every tab, 6px on the lit one.
- **Breathing sign** (`text-shadow: 0 0 12px currentColor`, pulsing over 2s, `animate-neon-glow`): neon text that needs to draw the eye. Scaled by `--glow`; still under reduced motion.

### Named Rules
**The Lit Means Active Rule.** A neon glow says "this is where you are" or "this is live". Never put a glow on a resting element for decoration.

**The No Glow Alone Rule.** Light has no glows, so a selected or active state never rests on a glow alone: give it a line too (`border-selection`, `ring-selection`, or `selection-edge`).

**The Glow Not Fade Rule.** Neon text pulses its halo, never its opacity. `animate-pulse` on neon pink drops it to about 3:1 at the trough; the glow keeps the letters at full colour. One 12px halo, never stacked.

## Shapes

Gently rounded, tool-like corners. Controls and buttons use 6px (`rounded-md`, the most common radius); cards and panels 8px (`rounded-lg`); marketing sections and hero panels 16px (`rounded-2xl`). Pills and avatars are fully round. Radix runs at `radius="large"`. Borders are 1px, with the header's 2px rule the only heavier line.

The physical objects keep their real geometry: placeholder cards are true 2.5" × 3.5", and spine labels match the binder's ring width.

## Components

### Signature utilities (app/theme.css)
Applied explicitly in components. The one class a utility reads is `border`: `shadow-offset` skips its hairline on a sheet with a full border.
- `focus-outline`: 2px `focus` outline, 2px clear of the control. Focus is always an outline, never a box-shadow ring (a shadow rule can clobber a ring).
- `shadow-offset`: the light mode's hard neon offset and its hairline (above).
- `selection-edge`: a 4px edge down a row's left in `selection-line`, for a committed selection on a hued pick. A different shape from the keyboard highlight's full ring, so "selected" and "where Enter lands" read apart by more than colour. It composes with ring and shadow utilities.
- `binder-tab`, `binder-row` + `tab-hue-X`: the index tabs and mobile menu rows; the lit one is `aria-current="page"`.
- `pip`, `pip-owned`, `pip-want`, `pip-missing`: the collection scoreboard's pips; in light they differ by shape as well as colour (a dot, a thick amber ring, a thin ring).
- `shelf-ledge`, `shelf-ledge-special`: the binder shelf's ledges.
- `brand-mark-mask`: the light mode's single-colour Mark (`public/logo-mark.svg`); `BrandMark` applies it, and dark keeps the neon PNG.

### Buttons
Crisp, solid and few. One neon fill per decision.
- **Shape:** gently rounded (6px).
- **Primary:** Binder Green fill, black ink, 8px × 16px, `text-sm`. Hover is `neon-green-hover`.
- **Cancel:** Show-Sign Pink fill, black ink (`NeonButton cancel`).
- **Destructive:** Tilt Red fill, black ink (`NeonButton destructive`, `Button variant="destructive"`), `neon-red-hover` under the pointer. A quiet destructive link or × is `ink-3` that turns `text-neon-red-text` under the pointer. In a confirm dialog the destructive button sits beside a cyan Cancel, never a pink one: red beside pink reads as one colour.
- **Secondary:** Marquee Cyan fill, black ink.
- **Neutral:** `button-neutral` fill, `ink` or `ink-2` text, `button-neutral-hover` under the pointer.
- **Disabled:** keyed off `disabled` and `aria-disabled` alike, so a button can stay in the tab order and still read as not live. Dark dims the neon to 45% opacity; light swaps it for the `button-neutral` fill and `ink-3` ink, because a neon fill at 45% on white reads as a pale, still-pressable button. Not-allowed cursor in both.
- **Quiet actions:** text or ghost buttons in `ink-2` that brighten on hover, for everything that isn't the decision.

### Inputs / Fields
- **Style:** `field` background, 1px `field-rule` border (3:1 in light), 6px radius, `ink` text, `ink-3` placeholder, 8px × 12px.
- **Focus:** the `focus-outline` (cyan in dark, violet in light).
- **Labels:** visible `text-sm` labels in `ink-2`, above the field (or left of it at 84px minimum width).

### Lists and pickers
- **Tile rows** (the set picker's columns): `bg-row border-row-rule hover:bg-row-hover`. White tiles with a visible edge in light, never a heavy grey tile.
- **Selected row:** the column's hued pick (`bg-pick-X border-pick-X-rule`) plus `selection-edge`.
- **Keyboard highlight** ("where Enter lands"): a green tint (`bg-neon-green/20`), a 2px inset `ring-neon-green-text`, and in dark a faint inner glow scaled by `--glow`.
- **Popover options:** `hover:bg-hover-raised`; the highlighted option takes the same green tint.

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** `raised` on `surface`; `field` for wells inside it.
- **Shadow Strategy:** none at rest in dark (tonal); `shadow-offset` on sheets in light; floating layers only.
- **Border:** 1px `rule` or `rule-strong` where a card meets a similar tone.
- **Internal Padding:** 16px; 32px on marketing panels.

### Navigation: Binder Index Tabs (signature)
The right-edge vertical tab stack is the binder metaphor made literal. Each tab is an icon plus a `text-base` label in `ink-3` at rest. Every tab is 170px wide; a resting tab sits 10px past the right edge and the active one slides fully out (hover pulls a resting tab out 6px), so the movement is a transform, never a width change. The active tab takes its section hue for text; in dark it sits on `raised-deep` and glows, in light every tab carries a 4px edge in its hue and the lit one 6px with a soft drop. Below 1024px the same destinations live in a slide-in panel from the right (0.24s, expo ease-out; a 0.15s fade under reduced motion).

### Header and Wordmark
The sticky header carries the brand mark and Neon wordmark at left and account actions at right, with sign-out as a Show-Sign Pink button (leaving, not destroying). The pulling logo appears on the public hero only, where it switches on once like a neon sign (dark, two flickers, lit, then it holds). It never loops, and under reduced motion it is simply lit.

### Clerk
`clerkAppearance(mode)` (`components/modules/clerk-appearance.ts`) skins every Clerk surface from `<ClerkProvider>` in the page's mode. Clerk renders outside our CSS, so the colours are literal hexes, taken from `tokens.ts` where they are roles. Clerk paints its text links in `colorPrimary` (our button fill), so the link elements are pointed at `neon-green-text`; in light a field's edge is drawn in `control`, because Clerk's own edge is 11% of `colorBorder`.

### Spinners
Spinners keep turning under reduced motion, at 2.4s a turn, because they are the only sign of loading.

## Do's and Don'ts

### Do:
- **Do** paint with roles, and pick the role by its job, not by its value in one mode.
- **Do** put black ink on every neon fill, in both modes.
- **Do** use `text-neon-X-text`, not `text-neon-X`, for neon text.
- **Do** keep each section in its tab's hue.
- **Do** give each sibling tool's icon its own neon hue (never pink or red).
- **Do** paint every destructive action Tilt Red, and keep pink for cancel.
- **Do** give a selected or active state a line as well as any glow or tint.
- **Do** scale every glow by `--glow`.
- **Do** honour `aria-disabled` on disabled buttons.
- **Do** stop the glow pulse under `prefers-reduced-motion`.
- **Do** print on white: print documents pin black on white and never load the app stylesheet; on-screen previews of paper use `bg-paper`.
- **Do** look at every new screen in both modes, at desktop and phone widths.

### Don't:
- **Don't** use a `dark:` variant, a grey palette step, `text-white`/`bg-black`, or a raw hex in a class. The lint rule refuses them.
- **Don't** branch on `[data-theme=light]` in a component's classes. If a role is missing, add it to `theme.css`, `@theme` and `tokens.ts` together.
- **Don't** use white text on neon pink, cyan or green.
- **Don't** fade neon text with `animate-pulse`; pulse the glow instead.
- **Don't** use the Neon display face anywhere but the wordmark.
- **Don't** set headings in gradient text; a heading takes its section's one hue (One Hue Per Section).
- **Don't** hand-mix a near-neon hex. `#00B7FF` and `#FF2EB3` crept into 80 files before the 2026-10 audit folded them back into Marquee Cyan `#00C2FF` and Show-Sign Pink `#FF2E9A`.
- **Don't** put a glow on a resting element.
- **Don't** use neon pink for anything but cancel, or for anything destructive: that is Tilt Red.
- **Don't** reach for a hued palette step (`bg-red-600`). Every hue has a role; the lint rule refuses the step.
