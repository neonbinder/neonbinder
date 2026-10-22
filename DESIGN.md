---
name: Neon Binder
description: A collector's binder, lit in neon — dark pages, glowing index tabs, crisp tools.
colors:
  neon-green: "#00D558"
  neon-pink: "#FF2E9A"
  neon-blue: "#00C2FF"
  neon-yellow: "#FFE600"
  neon-orange: "#FF9E00"
  neon-teal: "#00E5C0"
  neon-purple: "#A44AFF"
  neon-purple-text: "#B56BFF"
  ink-black: "#000000"
  page-black: "#0A0A0A"
  well-slate: "#0F172A"
  card-graphite: "#1F2937"
  deep-graphite: "#111827"
  rule-slate: "#334155"
  header-rule: "#1E293B"
  foreground: "#EDEDED"
  label-slate: "#CBD5E1"
  hint-slate: "#94A3B8"
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
    textColor: "{colors.ink-black}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    typography: "{typography.body}"
  button-cancel:
    backgroundColor: "{colors.neon-pink}"
    textColor: "{colors.ink-black}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-secondary:
    backgroundColor: "{colors.neon-blue}"
    textColor: "{colors.ink-black}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  input-dark:
    backgroundColor: "{colors.well-slate}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.card-graphite}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "16px"
  binder-tab-active:
    backgroundColor: "{colors.deep-graphite}"
    width: "170px"
---

# Design System: Neon Binder

## Overview

**Creative North Star: "The Neon Binder"**

The app is a binder. Sections are index tabs on the right edge, each with its own ink. Moving between pages turns a page. The pages themselves are black, and the work on them (checklists, card rows, label fields) sits on quiet graphite and slate. Neon is the binder's signage: the wordmark, the lit tab, the one button that moves you forward. It is not the wallpaper.

Because the people using it are both cataloguing at a desk and selling at a show table, the working surfaces are crisp and precise rather than playful. Dense lists, `text-sm` body, tight controls, keyboard-first. Personality comes from the wordmark, the glow and the voice of the copy, not from decorating the tools.

The app is dark-only. Paper is the one exception: labels, placeholder sheets and QR codes print black on white from their own isolated documents.

**Key Characteristics:**
- Black page, graphite cards, slate wells: three dark steps, no light theme.
- One neon hue per binder section, shown on the lit tab and its glow.
- Neon fills always carry black ink.
- The Neon display face appears only in the wordmark.
- Index-tab navigation carries the binder metaphor. Route changes are instant: no page-turn transition.

## Colors

A black room with neon signs in it: seven saturated signage hues on a near-black, cool-gray working palette.

### Primary
- **Binder Green** (neon-green): the brand and the forward action. Primary buttons, the Dashboard tab, success, the Radix accent (`accentColor="green"`, with the green scale remapped so step 9 is this exact value).

### Secondary
- **Show-Sign Pink** (neon-pink): cancel, destructive and sign-out. Never a decorative accent; pink always means "stop" or "undo".
- **Marquee Cyan** (neon-blue): secondary buttons, the Collection tab, and the focus ring on every dark input.

### Tertiary (section inks)
Each binder section owns one hue, used on its index tab text and glow:
- **Hazard Yellow** (neon-yellow): Inventory; also warnings.
- **Admin Amber** (neon-orange): Admin and other gated features.
- **Label Teal** (neon-teal): Print Shop, shipping and labels.
- **Profile Violet** (neon-purple): fills, borders, rings and glows for Profile and tabs. Text in this hue uses **Profile Violet Text** (neon-purple-text) instead, because the fill value fails 4.5:1 on graphite.

### Neutral
- **Ink Black** (ink-black): the text on every neon fill, and the `bg-background` utility.
- **Page Black** (page-black): the body ground (`--background`).
- **Slate Well** (well-slate): input wells and the deepest panels (the most-used surface).
- **Graphite** (card-graphite): cards, rows and drawers.
- **Deep Graphite** (deep-graphite): the active binder tab, recessed panels.
- **Slate Rule** (rule-slate): input borders and dividers.
- **Header Rule** (header-rule): the 2px rule under the sticky header.
- **Foreground** (foreground): body text.
- **Label Slate** (label-slate): field labels.
- **Hint Slate** (hint-slate): placeholders and secondary text.

### Named Rules
**The Signage Rule.** Neon marks identity and action: the wordmark, the lit tab, the primary button, a status. Working surfaces stay black, graphite and slate. If a screen reads as "neon everywhere", something is decorating instead of signalling.

**The Black Ink Rule.** Text on a neon fill is always black. White on neon pink is 3.44:1 and on cyan 2.07:1; black is 6.1:1 or better on every hue. One ink keeps the buttons reading as one family.

**The One Hue Per Section Rule.** A section's colour is fixed by its tab (Dashboard green, Collection cyan, Inventory yellow, Admin amber, Print Shop teal, Profile violet). Don't borrow another section's hue for emphasis.

## Typography

**Display Font:** Neon (self-hosted `Neon.ttf`, sans-serif fallback)
**Body Font:** Lexend (Google Fonts, 400/500/600/700 loaded; a metric-matched Arial fallback, `Lexend Fallback`, holds line breaks while it loads). Radix Themes' own system-font stack is overridden on `.radix-themes`, or every screen silently renders in San Francisco / Segoe UI.

**Character:** A glowing tube-sign script for the name, over a wide, very legible geometric sans built for reading. The sign is the only flourish; everything else is Lexend.

### Hierarchy
- **Display** (400, 30px; 20px below 1024px in the app header): the "Neon Binder" wordmark only.
- **Headline** (700, 1.5rem): page titles.
- **Title** (700, 1.25rem): section and card headings. `text-xl` is the most-used heading size.
- **Body** (400, 0.875rem): the working size. `text-sm` is the most-used class in the app.
- **Label** (400, 0.75rem): metadata, badges, helper text. Field labels are `text-sm` in Label Slate.

### Named Rules
**The One Sign Rule.** The Neon face is the wordmark. It is never used for headings, buttons or body copy.

**The Four Weights Rule.** Lexend runs at 400 (body), 500 (labels, tabs), 600 (card and section titles) and 700 (page headings, numbers). Nothing lighter than 400, nothing heavier than 700. Headings wrap balanced and prose wraps `pretty` by default.

## Layout

The signed-in shell is a sticky top header (wordmark left, account and sign-out right, a 2px Header Rule underneath), a main column, and the binder index tabs fixed to the right edge, vertically centred. From `lg` (1024px) up the tabs show; below it they collapse into a slide-in mobile nav behind a menu button. Below `sm` (40rem) the header is not sticky, and from `sm` up `scroll-padding-top: 80px` keeps scrolled-to targets clear of it.

Pages are padded generously (16px header, 32px main) and content runs in narrow measured columns: `max-w-md` for forms and dialogs, `max-w-2xl` for reading and marketing text. Feature grids step 1 → 2 → 3 columns at `md` and `lg`, with counts chosen so no card is orphaned. Spacing follows the 4px Tailwind scale; 8, 16 and 32px are the recurring steps.

## Elevation & Depth

Depth is mostly tonal: Page Black → Graphite → Slate Well, separated by Slate Rule borders. Shadows appear in two roles only: a generic drop shadow lifting floating layers (dialogs, menus, popovers) off the page, and a **neon glow** that marks "lit", meaning the active binder tab and a few focus-like highlights.

### Shadow Vocabulary
- **Floating layer** (Tailwind `shadow-lg` / `shadow-xl`): dialogs, dropdowns, popovers.
- **Tab glow** (`box-shadow: 0 0 12px 2px <hue>/0.4, inset 0 0 8px <hue>/0.1`): the active binder tab, in its section's hue.
- **Breathing sign** (`text-shadow: 0 0 12px currentColor`, pulsing over 2s): neon text that needs to draw the eye; still under reduced motion.

### Named Rules
**The Lit Means Active Rule.** A neon glow says "this is where you are" or "this is live". Never put a glow on a resting element for decoration.

**The Glow Not Fade Rule.** Neon text pulses its halo, never its opacity. `animate-pulse` on neon pink drops it to about 3:1 at the trough; the glow keeps the letters at full colour. One 12px halo, never stacked.

## Shapes

Gently rounded, tool-like corners. Controls and buttons use 6px (`rounded-md`, the most common radius); cards and panels 8px (`rounded-lg`); marketing sections and hero panels 16px (`rounded-2xl`). Pills and avatars are fully round. Radix runs at `radius="large"`. Borders are 1px Slate Rule, with the header's 2px rule the only heavier line.

The physical objects keep their real geometry: placeholder cards are true 2.5" × 3.5", and spine labels match the binder's ring width.

## Components

### Buttons
Crisp, solid and few. One neon fill per decision.
- **Shape:** gently rounded (6px).
- **Primary:** Binder Green fill, black ink, 8px × 16px, `text-sm`. Hover dims to 85%.
- **Cancel / Destructive:** Show-Sign Pink fill, black ink.
- **Secondary:** Marquee Cyan fill, black ink.
- **Disabled:** 45% opacity and a not-allowed cursor, keyed off `disabled` and `aria-disabled` alike so a button can stay in the tab order and still read as not live.
- **Quiet actions:** text or ghost buttons in gray that brighten on hover, for everything that isn't the decision.

### Inputs / Fields
- **Style:** Slate Well background, 1px Slate Rule border, 6px radius, foreground text, Hint Slate placeholder, 8px × 12px.
- **Focus:** Marquee Cyan ring (8.6:1 on the well).
- **Panel surface:** a field sitting on a Graphite card uses a recessed Deep Graphite well.
- **Labels:** visible `text-sm` labels in Label Slate, above the field (or left of it at 84px minimum width).

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** Graphite on Page Black; Slate Well for wells inside it.
- **Shadow Strategy:** none at rest (tonal); floating layers only.
- **Border:** 1px Slate Rule where a card meets a similar tone.
- **Internal Padding:** 16px; 32px on marketing panels.

### Navigation: Binder Index Tabs (signature)
The right-edge vertical tab stack is the binder metaphor made literal. Each tab is an icon plus a `text-base` label in gray at rest. Every tab is 170px wide; a resting tab sits 10px past the right edge and the active one slides fully out (hover pulls a resting tab out 6px), so the movement is a transform, never a width change. The active tab sits on Deep Graphite, takes its section hue for text and gets the matching tab glow. Below 1024px the same destinations live in a slide-in panel from the right (0.24s, expo ease-out; a 0.15s fade under reduced motion).

### Header and Wordmark
The sticky header carries the Neon wordmark at left and account actions at right, with sign-out as a Show-Sign Pink button. The pulling logo appears on the public hero only, where it switches on once like a neon sign (dark, two flickers, lit, then it holds; `filter: brightness`, because the logo's black ground is part of the image). It never loops, and under reduced motion it is simply lit.

### Spinners
Spinners keep turning under reduced motion, at 2.4s a turn, because they are the only sign of loading.

## Do's and Don'ts

### Do:
- **Do** put black ink on every neon fill.
- **Do** use `neon-purple-text` (#B56BFF), not `neon-purple`, for violet text.
- **Do** keep each section in its tab's hue.
- **Do** keep working surfaces on Page Black, Graphite and Slate Well, with neon only for signage and action.
- **Do** dim disabled neon buttons to 45% opacity and honour `aria-disabled`.
- **Do** give every dark input the Marquee Cyan focus ring.
- **Do** stop the glow pulse under `prefers-reduced-motion`.
- **Do** print on white: print documents pin black on white and never load the app stylesheet.

### Don't:
- **Don't** use white text on neon pink, cyan or green.
- **Don't** add a `prefers-color-scheme` rule or a light theme; the app is dark-only and the `dark:` variant keys off the `.dark` class.
- **Don't** fade neon text with `animate-pulse`; pulse the glow instead.
- **Don't** use the Neon display face anywhere but the wordmark.
- **Don't** set headings in gradient text; a heading takes its section's one hue (One Hue Per Section).
- **Don't** hand-mix a near-neon hex. `#00B7FF` and `#FF2EB3` crept into 80 files before the 2026-10 audit folded them back into Marquee Cyan `#00C2FF` and Show-Sign Pink `#FF2E9A`.
- **Don't** put a glow on a resting element.
- **Don't** use neon pink for anything but cancel, destructive and sign-out.
