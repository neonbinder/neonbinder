---
name: patterns-marketing-pages
description: Recurring accessibility gaps in the public marketing-page template (managing-inventory, shipping-labels, etc.) and the landing feature-card pattern
metadata:
  type: project
---

# Marketing Page Template — Recurring Gaps

Public marketing pages (`apps/web/app/<feature>/page.tsx`, e.g. `managing-inventory/page.tsx`,
`shipping-labels/page.tsx`) share one template: sticky header, hero, alternating
two-column sections with an inline decorative `<svg>` illustration + `▸` bullets,
then a `SignUpButton` CTA. Confirmed via `git log`/diff comparison across two of
these pages (NEO-118 audit, 2026-08-05) that the same gaps repeat in every page
built from this template — check for them every time a new page uses it:

1. **Inline decorative SVGs never get `aria-hidden="true"`.** Any `<text>` labels
   baked into the SVG (e.g. "SAVED ONCE", "ACTUAL SIZE", dimension marks) leak
   into the accessibility tree as real DOM text nodes and get announced
   out-of-context. Fix is always the same one-line addition per `<svg>` root.
2. **Heading hierarchy skips h2 → h4** for the three bullet sub-items under each
   section `<h2>` (no `<h3>` used anywhere in the template). This is consistent
   house style across every page built from this template (confirmed present
   pre-NEO-118 in `managing-inventory/page.tsx` too), so flag it as a
   documentation note / cross-page cleanup ticket rather than a per-PR blocker —
   fixing it in only one page would make that page inconsistent with its
   siblings.
3. **No per-route `document.title`.** The whole SPA shares one static
   `<title>Neon Binder</title>` from `index.html`; most pages (marketing or app)
   don't set their own. **Update (NEO-172, 2026-08-18): a fix now exists** —
   `apps/web/src/hooks/useDocumentTitle.ts` sets `document.title` on mount and
   restores the prior title on unmount. First consumer is
   `app/profile/api-keys/page.tsx`. Still not adopted by marketing pages or the
   other `/profile` sections, so still flag the gap where you find it — but the
   fix is now "call `useDocumentTitle("X | Neon Binder")`", not "propose a
   platform-level ticket from scratch."

## Landing feature-card pattern (`app/landing.tsx`)

Feature cards are `<button>` elements whose accessible name is the
concatenation of ALL descendant text (emoji + `<h3>` + `<p>` body copy), because
that's how the browser's accname algorithm treats a button. This has been true
since before NEO-118 (3 cards) and remains true with a 4th card added — adding a
card in the same structure does not regress anything. Not worth flagging unless
the copy itself changes to something non-descriptive.
