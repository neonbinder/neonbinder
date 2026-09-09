---
name: patterns-printable-artifacts
description: Accessibility gaps recurring in "printable artifact" features — a page with a form driving a live on-screen preview of a print-only component (PlaceholderSheet, ShippingLabel-style)
metadata:
  type: project
---

# Printable-artifact pages (form + live preview of a print component)

Confirmed in `apps/web/app/print/placeholders/page.tsx` + `components/modules/PlaceholderSheet/placeholder-sheet.tsx`
(NEO-157, audited 2026-08-13). This shape will repeat for future Print Shop tools — check each new one for
these four things.

## 1. "Escape cancels" applied to a persistent full-page form, not a dialog

[[patterns-modal-dialog]]'s "Escape cancels" convention is written for actual modals — a temporary session with
a clear exit. A **persistent full-page form** (no modal, nothing to "close") is a different context: binding
`onKeyDown` for Escape on the page's outer wrapper `<div>` to a full-form reset means ANY Escape press while
focus is anywhere in the form — including mid-edit on a text field — silently discards typed input and reverts
every control to defaults, with focus left exactly where it was (so a sighted user's cursor sits in a field
whose value just changed underneath it with no visual cue). Live-verified in `page.tsx`: typed "42" into the
count field, pressed Escape, value silently reverted to "9", `document.activeElement` unchanged. This is a
redundant shortcut layered on top of an already-fully-accessible visible "Reset" `<button>` — the shortcut adds
data-loss risk without adding keyboard access (2.1.1 is already satisfied by the button). Cite under **3.2.2 On
Input** (context/value change not advised in advance). Fix: either drop the div-level handler entirely (the
visible Reset button already covers keyboard users), or if kept, don't fire while `document.activeElement` is a
text-entry control, and move focus to the Reset button afterward so the action is perceivable.

## 2. Numeric-count validity errors not associated with the field

Recurring shape: a count/quantity `<Input bare>` has a *static* `aria-describedby` (always the same hint id)
while the actual "why is this invalid" message is a separately-conditionally-rendered `<p id="...">` wired via
`aria-describedby` only to the submit button, never to the input. Screen reader users focused on the invalid
field hear only the static hint, never the error, and `aria-invalid` is never set. Live-verified: typed "200"
(max is 90) into the count field — `aria-invalid` stayed `null`, `aria-describedby` stayed
`"placeholder-count-hint"` only. Cite **3.3.1 Error Identification** + **4.1.2** (state not exposed). Fix:
`aria-invalid={!countIsValid}` and `aria-describedby={countIsValid ? "hint-id" : "hint-id error-id"}` on the
input itself, in addition to (not instead of) the button's describedby.

## 3. Nested radio group inside an outer `<fieldset>` loses its own legend

A conditionally-revealed sub-group of radios (e.g. flip-edge choices shown only when a "duplex" checkbox is on)
sitting inside the SAME `<fieldset>` as the checkbox, headed by a plain `<span className={LABEL_CLASS}>}` instead
of its own `<fieldset><legend>`. Live-verified via `input.closest('fieldset').querySelector('legend').textContent`
— every radio in the sub-group reports the OUTER fieldset's legend ("Two-sided printing") as its group context;
the visually-styled span heading ("Which edge your printer flips") is invisible to the accessibility tree. Cite
**1.3.1 Info and Relationships** / **3.3.2 Labels or Instructions**. Fix: nested `<fieldset>` is valid HTML —
wrap the conditional sub-group in its own `<fieldset><legend>{...}</legend>...</fieldset>` instead of a span.

## 4. On-screen preview of the print component floods the a11y tree with redundant text

The print component itself is real text (not an image), which is correct for the *print* output, but when the
same element is also rendered live in an on-screen preview list, every cell's number/side-label/sheet-caption
becomes a separate unlabeled DOM text node with no grouping semantics. Live-verified: default view (9 placeholders,
duplex on) produced 2 `<li>`s whose combined `innerText` was ~80 words / 54 redundant fragments
(`1 FRONT Sheet 1 2 FRONT Sheet 1 ...`), on top of a `<span>` caption per `<li>` ("Sheet 1 — front") that already
gives an SR user everything they need, plus a page-level `role="status"` summary paragraph. Fix from the **page**
side only (never edit the printable component itself — it must stay class-free/inline-style-only for the print
serialization contract, see the component's own header comment): add `aria-hidden="true"` to the bordered
scaled-preview wrapper `<div>` that contains the `<PlaceholderSheet>` instance, leaving the sibling `<span>`
caption (outside that div, still inside the `<li>`) as the accessible content for that list item. Cite **1.1.1
Non-text Content** (treat the preview as a graphical unit with a text alternative already available elsewhere,
not as literal content to be read cell-by-cell).

## Positives confirmed in this audit (don't re-flag)

- Heroicons `<PrinterIcon>`/`<Squares2X2Icon>` render with `aria-hidden="true"` by default — no fix needed, verified
  live via DOM query. Don't assume marketing-page-template icon gaps ([[patterns-marketing-pages]]) apply to
  Heroicons components; that pattern is specifically about hand-rolled inline `<svg>`.
- `role="status"`/`role="alert"` live regions here are correctly always-mounted (empty when idle), matching the
  house pattern in [[patterns-forms-and-contrast]].
- Focus ring on radio/checkbox option rows uses `focus-within:ring-2 ring-neon-purple` — `#A44AFF` on `#0a0a0a`
  computes to ~4.72:1, comfortably clears the 3:1 non-text/focus-indicator threshold.
