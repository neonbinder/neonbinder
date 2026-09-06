---
name: footer-hoisted-decision-controls
description: What breaks (and what does not) when a per-row primary action is hoisted out of a scrolling dialog body into a fixed footer — NEO-236's EntityReviewWizard. Group naming, dropped utility classes, target size, and the flex-priority arbitration that squeezes a blocked-reason message to nothing.
metadata:
  type: patterns
---

## The move itself is a 2.4.3 IMPROVEMENT, not a regression

`EntityReviewWizard.tsx` moved the per-row decision controls (`Add as New
{Player|Team}` / `Link to {name}` / `Link to Existing…` / `Skip …` / `Back`)
out of the `flex-1 min-h-0 overflow-y-auto` body into the dialog's fixed
footer, because on a 1024x629 viewport they rendered below the dialog.

Reading order becomes: row content → footer row 1 decision controls → footer
row 1 dialog buttons (`Cancel`, `Confirm & Save`) → footer row 2. That is the
ordinary form-then-footer-action dialog shape and reads fine. **Do not flag
"the control comes after the content it acts on" as a 2.4.3 defect** — it is
the same relationship a submit button has to a form.

Two things it genuinely costs, both fixable without touching an accessible
name:

1. **Group identity (SC 2.4.6 / 4.1.2).** In the body the primary sat under
   `<h3>New Team: Sydney Blue Sox</h3>`, so `Add as New Team` needed no more
   context. From the footer the heading is a whole scrolling body away, and
   Tab/virtual-cursor arrival announces only "Add as New Team, button". Fix:
   `role="group" aria-label={`Decision for ${current.name}`}` on the container.
   This file already used that exact phrasing for the read-only decided panel,
   and the two are mutually exclusive by construction, so the name can be
   reused without ambiguity. **Never fix this by appending the row name to the
   button's own `aria-label`** — those strings are Maestro contracts here.
2. **Focus survival is actually BETTER after the move.** The controls stay
   mounted in the same DOM slot as the presented row advances, so focus on the
   primary survives a decision. `allDecided` still unmounts them, and the
   existing `confirmButtonRef.current?.focus()` effect catches that.

## Hoisting a subtree into a differently-classed parent silently drops utility classes

Row 2's rewrite replaced a `<p className="flex min-h-4 items-center gap-3
text-xs text-gray-400">` wrapper with a bare `<div className="flex min-h-6
items-center gap-3">` and re-added `text-xs` to the BUTTONS it now holds — but
not to the two `<p>`s. Those then inherit Radix `<Theme>`'s `--gray-12` at
16px. Not a contrast failure (gray-12 on gray-900 is ~15:1) but it defeats the
`min-h-*` height reservation the footer's no-movement invariant is measured
against. **When a wrapper that carried `text-*`/`text-gray-*` for its children
is replaced, diff the child list for who lost what** — the ones that kept a
colour of their own (`text-[#FF2EB3]`) hide the loss best.

Related trap: `body { color: var(--foreground) }` in `app/globals.css` is
`prefers-color-scheme`-driven (#ededed dark / #171717 light) while every panel
here is unconditionally `bg-gray-900`. An element that inherits from `body`
rather than from a Radix `<Theme>` would be near-black on near-black in OS
light mode. Radix `<Theme>` (root sets `appearance="dark"`, nested `<Theme>`s
inherit it through React context even across a `createPortal`) is what saves
these — do not assume inheritance is safe outside a Theme.

## `py-2 -my-2` is the right 2.5.8 fix inside a height-reserved footer

`p-2 -m-2` (the convention documented in [[target-size-2.5.8]]) overlaps
horizontally when two padded links sit at `gap-3` (12 - 8 - 8 = -4px). In a
flex row of text links use **`py-2 -my-2`**: 16px line-height + 16px padding =
a 32px hit area, and the negative vertical margin keeps the flex line at 16px
so the footer's height does not change whether the links are mounted or not.
Plain `py-1.5` would have added 4px that appears and disappears with the bulk
links, moving row 1 — the exact defect the footer exists to prevent.

## The unfixed one: flex-priority arbitration truncates the blocked-create reason

Row 2 is `[blocked reason: flex-1 min-w-0 truncate] [role=status: truncate]
[Stop] [bulk links: shrink-0 whitespace-nowrap]`, and a passing test pins
"the links never yield; the status text beside them is what gives way".
At the dialog's 672px (624px content) width the two bulk links are ~384px and
the status line ~217px, both `shrink-0` — so the blocked reason gets ~215px
falling to ~0px, and messages like "3 career teams still need a team decision,
or untick them." (58 chars) are clipped to nothing. The reason a control will
not fire is then invisible to a sighted operator (SC 3.3.1) while remaining
correct for AT via `aria-describedby`. **Flagged for the owner, not fixed** —
arbitrating between two of their own stated layout invariants is their call,
and the honest options all move something: give the reason its own row-1 line
(row 1 wraps, so it costs footer height that appears while typing), let the
bulk links truncate instead (contradicts the pinned test), or put the reason
back in the body beside the field that causes it.

## `aria-describedby` across a portal/footer boundary is a non-issue

`createBlockedId` moved from the body into the footer while `NewTeamForm`'s
fields still point at it. IDREF resolution is document-scoped, not
subtree-scoped — no defect, no fix. Say so explicitly when asked; it is a
natural thing to worry about and a natural thing to waste a fix on.
