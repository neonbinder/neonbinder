---
name: patterns-clerk-components
description: Accessibility facts specific to Clerk prebuilt components in this codebase — appearance variable naming, UserButton.MenuItems default-item behavior, and the ErrorAlert+Sentry.ErrorBoundary fallback pattern used to wrap them
metadata:
  type: project
---

# Clerk `appearance` variable naming (verified against clerk.com docs, 2026-08-18)

Confirmed via Clerk's own `variables` reference page during the NEO-172 API Keys audit. The
pre-2025-07-15 (deprecated but still-served-by-some-clerk-js-majors) names map 1:1 to current names:

| Deprecated (pre-2025-07-15) | Current | Role |
|---|---|---|
| `colorText` | `colorForeground` | primary text |
| `colorTextOnPrimaryBackground` | `colorPrimaryForeground` | text on a colorPrimary-colored surface (e.g. primary button label) |
| `colorTextSecondary` | `colorMutedForeground` | secondary/muted text |
| `colorInputText` | `colorInputForeground` | text inside inputs |
| `colorInputBackground` | `colorInput` | input fill |

**Important:** the current API has **no per-color foreground token** for `colorDanger`,
`colorSuccess`, or `colorWarning` (no `colorDangerForeground` etc. exists) — only
`colorPrimaryForeground` exists for a colored-background/text pairing. Don't flag a missing
danger/success/warning foreground token as a gap; there's nothing to map.

`apps/web/components/modules/clerk-appearance.ts` (NEO-172) carries both names for every role
EXCEPT this one: it has `colorText`/`colorTextSecondary`/`colorInputText`/`colorInputBackground` but
is missing `colorTextOnPrimaryBackground`. That's a real, source-confirmed gap in an otherwise
deliberate dual-naming strategy (the file's own header comment states the intent: "carrying both
names means the page is themed either way"). Flag it: on whichever clerk-js major resolves the old
name, the primary-button text color is unset and falls back to Clerk's stock default, which is a
real risk on a saturated `colorPrimary` like this app's neon-green `#00D558` (white text on it is
only ~1.97:1, script-verified — a 1.4.3 failure if that's what renders). Fix is a single added line;
per the file's own stated mechanism, an unrecognized key is harmlessly ignored on the other version.

# `colorBorder` and neon-on-dark contrast in this file (verified 2026-08-18)

`colorBorder: "#1e293b"` (slate-800) against `colorBackground`/`colorInput` (`#0a0a0a` / `#0f172a`)
computes to ~1.35:1 / ~1.22:1 — both far under the 3:1 needed for 1.4.11 Non-text Contrast, and this
token drives real input-field/card borders in Clerk's rendered UI, not a decorative divider. This is
the SAME slate-800-on-dark trap already logged in [[patterns-forms-and-contrast]] for our own Tailwind
classes — now confirmed to leak into third-party component theming too. Treat any future
`colorBorder`/border-token choice in this palette as needing `slate-500` (`#64748b`, ~4.16:1) or
lighter, not `slate-600`/`slate-800`.

All the other token pairs in `clerk-appearance.ts` (colorForeground, colorMutedForeground,
colorDanger, colorSuccess, colorWarning, colorInputForeground, all against colorBackground/colorInput)
passed AA comfortably (>5:1) when script-verified in the same audit — the palette author clearly
already accounted for contrast on the direct text/background pairs; the border token was the one gap.

# `UserButton.MenuItems` + a single custom item does NOT remove the defaults

Verified against Clerk's own docs (`clerk.com/docs/react/guides/customizing-clerk/adding-items/user-button.md`)
during the NEO-172 audit: Clerk's own canonical "how to add a menu item" example shows exactly
`<UserButton><UserButton.MenuItems><UserButton.Link .../></UserButton.MenuItems></UserButton>` — one
custom item, no re-declaration of "Manage account" or "Sign out" — presented as the complete, working
pattern. So adding one `<UserButton.Link>` (as `apps/web/components/modules/binder-header.tsx` does
for NEO-172's "API Keys" item) does not strip the default items; `<UserButton.Action label="manageAccount" />`
/ `label="signOut"` are only needed to REORDER defaults relative to custom items, not to restore them.
Don't re-litigate this on the next PR that adds a `UserButton.Link` — it's settled.

# `ErrorAlert` + `Sentry.ErrorBoundary` fallback pattern — recurring gap to check

Shape: a page wraps a Clerk (or other third-party) component in `<Sentry.ErrorBoundary fallback={<ErrorAlert error="..." />}>`
so a runtime throw degrades to an explanation instead of a blank route. First real usage:
`apps/web/app/profile/api-keys/page.tsx` (NEO-172) — `ErrorAlert` itself
(`apps/web/components/primitives/ErrorAlert.tsx`) previously had no live production usage (only a
`.design-sync/previews/` file referenced it).

`ErrorAlert` renders a plain `<div><p>...</p></div>` — no `role="alert"`/`aria-live`, and nothing
moves focus to it when it swaps in. Its own text-contrast is fine (`#FF2E9A` on the composited
`rgba(255,46,154,0.1)` panel over `#0a0a0a` ≈ 5.34:1, script-verified), so the defect is purely
4.1.3 Status Messages / focus-management, not color. Because the file's own header comment says this
pattern is meant to be reused ("so the next Clerk component uses the same palette"), expect this
exact gap to recur on every future `Sentry.ErrorBoundary` + `ErrorAlert` pairing until the primitive
itself is fixed — check `ErrorAlert.tsx` first before re-diagnosing it per-page. Fix: add
`role="alert"` to the primitive's wrapper div (assertive live regions don't need `aria-live` too —
`role="alert"` implies it); consider also moving focus to it on mount via a ref, guarded to only fire
when `error` transitions from falsy to truthy so a screen reader user gets exactly one announcement.

# `useDocumentTitle` hook now exists (NEO-172)

`apps/web/src/hooks/useDocumentTitle.ts` — new, sets `document.title` on mount and restores the
previous title on unmount. First (and as of this audit, only) consumer is
`app/profile/api-keys/page.tsx`. This supersedes the old note in [[patterns-marketing-pages]] that "no
per-route title mechanism exists anywhere" — it now exists, just isn't adopted elsewhere yet. Future
audits of pages lacking a 2.4.2 Page Titled fix should point at this hook as the concrete remedy
instead of recommending a platform-level react-router title-management ticket from scratch.

Confirmed still under-adopted as of 2026-08-18 (NEO-170 audit): new top-level route
`app/pipeline-runs/page.tsx` does NOT call it — still only the one consumer. This hook's adoption is
clearly not happening automatically as new pages get added; flag every new top-level page under
`app/*/page.tsx` that lacks a `useDocumentTitle(...)` call as a 2.4.2 gap until this becomes a lint rule
or a route-level convention.
