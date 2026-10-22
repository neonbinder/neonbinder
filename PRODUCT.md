# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The Vite + React Router SPA in `apps/web` (desktop and phone browsers). The React Native client (`NeonBinderApp`) is paused and out of scope until it returns.

## Users

**Primary: the collector who sells.** One person who keeps a sports card collection in binders and also moves cards: online across marketplaces (BuySportsCards, SportLots, eBay, and others) and in person from a table at card shows. Free collection tracking brings them in; the selling tools are why they stay.

**Secondary: the operator.** Builds and curates NeonBinder's set and checklist data in `/admin` (Set Builder, players, teams, leagues, franchises). Desktop-first and keyboard-heavy work.

## Product Purpose

NeonBinder is one hub for a card collection and everything a collector-seller does with it: track what you own against verified checklists, list it across marketplaces and at shows from one inventory, ship it, and print the physical goods a binder needs. Success is a collector-seller who runs both their collection and their selling out of NeonBinder instead of a pile of marketplace tabs and spreadsheets.

## Positioning

The whole loop in one place, built on data NeonBinder owns: collection, cross-marketplace listing, show sales, shipping, and printing. **The single biggest differentiator is one inventory that lists across marketplaces and sells at a show table.** Underneath it, NeonBinder owns its sets, checklists, players and teams; marketplaces are an initial input and a listing destination, never the source of truth (see the product invariant in `CLAUDE.md`).

## Operating Context

- **At home, at a desk:** building and filling binders, identifying cards from photos, cleaning up checklists, preparing listings, printing labels and placeholder sheets.
- **At a card show, on a phone:** QR codes on cards; buyers scan to see a running total and pay via PayPal, Venmo or Cash App. No buyer app download.
- **Shipping:** 4×6 labels and plain-white-envelope (PWE) USPS letter postage.
- **Physical materials:** 3-ring binders with 9-pocket pages, true-size 2.5" × 3.5" placeholder cards (double-sided), binder-spine labels in team colours on Letter or A4.

## Capabilities and Constraints

- **Shipped:** collection tracking against NB checklists (`/collection`, demo on `/binder-tracking`); AI card identification from photos (crop, orient, classify); the Print Shop (spine labels with team-colour prefill and eleven athletic typefaces, 9-pocket placeholder sheets, QR codes, blackout labels); shipping labels and PWE postage; public profile and show sale page (`/u/:username`, `/u/:username/sale`); marketplace credential linking for BSC and SportLots (passwords never stored).
- **Not yet shipped:** listing inventory to marketplaces. BSC and SportLots are real integrations for data and login; eBay, MySlabs and MyCardPost are stubs. Copy must not present cross-listing as live until it is.
- **Tiers:** free tier is collection tracking ("free forever"); a paid tier for multi-platform inventory is announced as coming soon. No pricing exists.
- **Terminology:** set, variant type (Base / Insert / Parallel), checklist, card number, player, team, placeholder, spine label, PWE, show/table, binder, 9-pocket.
- **Data rules that shape UI:** a row with marketplace ids and a row without behave identically (no "custom" concept); ambiguous matches go to the operator to decide, never guessed.

## Brand Commitments

- **Name:** Neon Binder (wordmark), NeonBinder in running text.
- **Voice (binding):** 90s hobby-shop. Playful, card-shop slang and a wink ("That's how you run a table, dude", "Your shelf never looked so rad"). Confirmed as the brand by the owner.
- **Theme (existing, recorded only):** dark UI with neon accents; neon green, neon pink and blue are the named brand colours, with `apps/web/tailwind.config.js` as source of truth; Lexend; the Neon display face (`apps/web/public/Neon.ttf`); the `PullingLogo` animated mark.

## Evidence on Hand

- Real product surfaces and copy: `/`, `/about`, `/binder-tracking`, `/print-shop`, `/shipping-labels`, `/ai-card-identification`, `/managing-inventory`.
- Real card imagery for fixtures: `apps/web/public/placeholder-fixtures*`.
- **Absent, never fabricate:** testimonials, user or collector counts, customer logos, press, pricing, benchmarks. The existing line "Join collectors and sellers across the country who trust Neon Binder" is unsupported and should not be extended.

## Product Principles

1. **One inventory, every place it sells.** Marketplace and show selling come from the same NB record; nothing is entered twice.
2. **NB owns the data.** Marketplaces feed and receive; they never decide what the collector sees.
3. **The binder is real.** Digital features earn their place by matching the physical hobby: true sizes, real team colours, real pages.
4. **The operator decides the ambiguous.** When data disagrees, show the choices; never guess silently.
5. **Fast at a desk, fast at a table.** Keyboard-first for the at-home work, thumb-first for the show floor.

## Accessibility & Inclusion

- WCAG 2.2 AA, enforced by the `accessibility-auditor` agent and axe checks in the Playwright suite (desktop and mobile).
- Every flow is fully operable from the keyboard: Enter confirms, Escape cancels, sensible defaults are preselected.
