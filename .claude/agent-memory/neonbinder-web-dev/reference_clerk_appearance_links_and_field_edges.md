---
name: clerk-appearance-links-and-field-edges
description: Clerk (clerk-js 6) paints text links in colorPrimary and draws a field's edge as a 1px box-shadow at 11% of colorBorder — variables alone cannot fix either; use appearance.elements
metadata:
  type: reference
---

Two Clerk appearance quirks that `variables` cannot reach (measured 2026-10-22,
NEO-356, live clerk-js 6 via the CDN):

- **Links follow `colorPrimary`.** "Sign up", "Forgot password?", resend and
  edit links all take the primary colour, which in this app is the neon-green
  BUTTON FILL (1.9:1 on white). There is no link variable. Fix per element:
  `elements: { footerActionLink, formFieldAction, formResendCodeLink,
  identityPreviewEditButton: { color } }`.
- **A field's edge is not a border.** `.cl-formFieldInput` has `border: 0` and
  draws `box-shadow: 0 0 0 1px <colorBorder at 11% alpha>`, so even a 4.7:1
  `colorBorder` renders far under 3:1 (WCAG 1.4.11). Override with
  `formFieldInput: { "&:not(:focus)": { boxShadow: "0 0 0 1px <hex>" } }` —
  the `:not(:focus)` keeps Clerk's own focus ring.

**How to apply:** verify with a Playwright probe of `getComputedStyle` on
`.cl-formFieldInput` / `.cl-footerActionLink` after opening the sign-in modal;
the live UI can change under a CDN major without a package bump
([[clerk-ui-strings-live-in-clerk-ui-package]]).
