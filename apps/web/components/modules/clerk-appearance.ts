import type { ThemeMode } from "@/src/theme/theme-mode";
import { tokenHex } from "@/src/theme/tokens";

/**
 * NEO-172 — the dark-neon skin for Clerk's prebuilt components.
 *
 * Clerk components mount their own DOM inside an iframe-less portal that our
 * Tailwind classes cannot reach, so the only way to make one look like the rest
 * of the app is Clerk's `appearance` prop. There was no such config in the repo
 * before this: `<ClerkProvider>` in src/main.tsx passes only a publishable key,
 * and `<UserButton />` / `<SignInButton />` render in Clerk's stock light-ish
 * theme.
 *
 * WHY THIS IS NOT ON `<ClerkProvider>`: a provider-level appearance restyles
 * every Clerk surface at once, including the sign-in and sign-up screens that
 * the Maestro auth flows drive by visible text and position. Re-skinning those
 * is a deliberate change with its own test pass, not a side effect of adding a
 * settings page. So this is opt-in per component today — pass it as
 * `appearance={clerkNeonAppearance}` — and it is exported from a shared module
 * so the next Clerk component uses the same palette rather than inventing one.
 *
 * COLOUR SOURCE: the colour roles in app/theme.css. `colorPrimary` is Neon
 * Green (the app's primary), `colorDanger` is Neon Pink (the app's
 * cancel/destructive colour), and the greys are the page's surface and ink.
 *
 * WHY BOTH `colorForeground` AND `colorText`: Clerk renamed several appearance
 * variables between the clerk-js 5 and 6 UI (`colorText` → `colorForeground`,
 * `colorInputText` → `colorInputForeground`, `colorTextSecondary` →
 * `colorMutedForeground`). `@clerk/clerk-react` loads clerk-js from Clerk's CDN
 * at runtime by MAJOR version, so which set is live is not pinned by our
 * package.json. Unknown keys are ignored by both, so carrying both names means
 * the page is themed either way instead of silently falling back to the stock
 * palette on one of them.
 */

/**
 * Neon Binder's palette for one mode, in the shape Clerk's `appearance` prop
 * expects. NEO-356: `<ClerkProvider appearance={clerkAppearance(mode)}>` in
 * src/main.tsx now skins every Clerk surface (sign-in, sign-up, the account
 * menu) in the page's mode, so the opt-in-per-component note above is
 * history. Clerk renders outside our CSS, so these are literal hexes; the
 * ones that are roles come from src/theme/tokens.ts (the mirror of
 * app/theme.css), so they cannot drift.
 */
export function clerkAppearance(mode: ThemeMode) {
  const c =
    mode === "light"
      ? {
          primary: "#00D558", // neon-green fill
          onPrimary: "#000000",
          background: "#FFFFFF", // raised
          foreground: "#18122B", // ink
          muted: "#F0F2F9", // hover
          mutedForeground: "#57516E", // ink-3
          input: "#FFFFFF", // field
          // control (4.7:1 on white): Clerk draws input outlines and
          // dividers with it, which need 3:1 (WCAG 1.4.11).
          border: tokenHex("control", "light"),
          // Tilt Red as text: Clerk paints errors and its destructive buttons
          // (Remove, Delete account) with it, and destructive is red (NEO-356).
          danger: tokenHex("neon-red-text", "light"),
          success: "#007A3B", // neon-green as text
          warning: "#7A6400", // neon-yellow as text
          // Clerk's alpha scale for ghost controls and hovered rows: ink.
          neutral: "#18122B",
          // Links ("Sign up", "Forgot password?") are text, and Clerk paints
          // them in colorPrimary: the green FILL is 1.9:1 on white. The green
          // as text is 4.5:1 or better.
          link: tokenHex("neon-green-text", "light"),
        }
      : {
          primary: "#00D558", // neon-green
          onPrimary: "#0a0a0a",
          background: "#0a0a0a",
          foreground: "#ededed",
          muted: "#0f172a", // slate-900
          mutedForeground: "#94a3b8", // slate-400
          input: "#0f172a", // slate-900
          // control (slate-500), NOT slate-800: #1e293b computes to ~1.3:1
          // against both the page and input backgrounds — far under the 3:1
          // non-text minimum (WCAG 1.4.11) for the input outlines and
          // dividers Clerk draws with it.
          border: tokenHex("control", "dark"),
          danger: tokenHex("neon-red-text", "dark"), // Tilt Red as text
          success: "#00D558", // neon-green
          warning: "#FFE600", // neon-yellow
          // Clerk derives an alpha scale from this for ghost/outline controls:
          // the text of the <APIKeys/> expiry select ("Select date", "1 Day"),
          // hovered rows, menu items. Its default is black, which Clerk's docs
          // say to flip to white on a dark theme; left unset, that select
          // rendered black at 62% over #0a0a0a, ~1.03:1 (WCAG 1.4.3 failure,
          // NEO-341). Same name in clerk-js 5 and 6.
          neutral: "#ededed",
          link: "#00D558", // the green reads as text on #0a0a0a
        };
  return {
    variables: {
      // clerk-js 6 / @clerk/ui names
      colorPrimary: c.primary,
      colorPrimaryForeground: c.onPrimary,
      colorBackground: c.background,
      colorForeground: c.foreground,
      colorMutedForeground: c.mutedForeground,
      colorMuted: c.muted,
      colorInput: c.input,
      colorInputForeground: c.foreground,
      colorBorder: c.border,
      colorDanger: c.danger,
      colorSuccess: c.success,
      colorWarning: c.warning,
      colorNeutral: c.neutral,
      // clerk-js 5 names for the same roles
      colorText: c.foreground,
      colorTextSecondary: c.mutedForeground,
      colorInputBackground: c.input,
      colorInputText: c.foreground,
      colorAlphaShade: c.neutral,
      // clerk-js 5 name for colorPrimaryForeground's role. Without it, a v5
      // clerk-js falls back to its stock (light) CTA text, which on our
      // neon-green primary computes to ~2:1 (WCAG 1.4.3 failure).
      colorTextOnPrimaryBackground: c.onPrimary,
      // Shared by both
      fontFamily: "Lexend, sans-serif",
      borderRadius: "0.5rem",
    },
    // Clerk has no link variable: its text links follow colorPrimary, which
    // is our button FILL. Point each link element at the green as text.
    elements: {
      footerActionLink: { color: c.link },
      formFieldAction: { color: c.link },
      formResendCodeLink: { color: c.link },
      identityPreviewEditButton: { color: c.link },
      // Clerk draws a field's edge as a 1px box-shadow in colorBorder at 11%
      // alpha, which on white is far under 3:1 (WCAG 1.4.11). Light draws it
      // in `control` at full strength instead. Not while focused, so Clerk's
      // own focus ring still shows. Dark keeps Clerk's edge, as before.
      ...(mode === "light"
        ? {
            formFieldInput: {
              "&:not(:focus)": { boxShadow: `0 0 0 1px ${c.border}` },
            },
          }
        : null),
    },
  } as const;
}
