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
 * COLOUR SOURCE: tailwind.config.js. `colorPrimary` is Neon Green (the app's
 * primary), `colorDanger` is Neon Pink (the app's cancel/destructive colour),
 * and the greys match the `--background` / `--foreground` tokens in
 * app/globals.css.
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

/** Neon Binder's palette, in the shape Clerk's `appearance` prop expects. */
export const clerkNeonAppearance = {
  variables: {
    // clerk-js 6 / @clerk/ui names
    colorPrimary: "#00D558", // neon-green
    colorPrimaryForeground: "#0a0a0a",
    colorBackground: "#0a0a0a",
    colorForeground: "#ededed",
    colorMutedForeground: "#94a3b8", // slate-400
    colorMuted: "#0f172a", // slate-900
    colorInput: "#0f172a", // slate-900
    colorInputForeground: "#ededed",
    colorBorder: "#1e293b", // slate-800
    colorDanger: "#FF2E9A", // neon-pink
    colorSuccess: "#00D558", // neon-green
    colorWarning: "#FFE600", // neon-yellow
    // clerk-js 5 names for the same roles
    colorText: "#ededed",
    colorTextSecondary: "#94a3b8",
    colorInputBackground: "#0f172a",
    colorInputText: "#ededed",
    colorAlphaShade: "#ededed",
    // Shared by both
    fontFamily: "Lexend, sans-serif",
    borderRadius: "0.5rem",
  },
} as const;
