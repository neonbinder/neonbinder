---
name: clerk-ui-strings-live-in-clerk-ui-package
description: Clerk's prebuilt-component text is NOT in node_modules — clerk-react loads clerk-js by MAJOR from Clerk's CDN and the UI (plus every en-US string) ships in a separate @clerk/ui bundle; how to get verbatim strings for Maestro selectors
metadata:
  type: reference
---

To get the **verbatim visible strings** of a Clerk prebuilt component (`<APIKeys>`,
`<UserProfile>`, `<SignIn>`…) — which a Maestro flow needs, since it can only
select on visible text — do NOT grep `apps/web/node_modules/@clerk/*`. The
strings are not there.

**Why:** `@clerk/clerk-react` ships no UI. At runtime
`@clerk/shared/dist/versionSelector.mjs` resolves a MAJOR version and
`loadClerkJsScript.mjs` fetches two scripts from the Clerk CDN:
`@clerk/clerk-js@<major>/dist/clerk.browser.js` **and**
`@clerk/ui@<major>/dist/ui.browser.js`. Since the clerk-js 6 line, clerk.browser
only exposes `mountX()` — the components and the whole en-US localization
default live in **@clerk/ui**. Neither is pinned by `package.json`, so the live
strings can change under us without a dependency bump.

**How to apply** (all in the scratchpad, never install into the repo):

1. Read the two fallback versions in
   `node_modules/@clerk/shared/dist/versionSelector.mjs` (`packageVersion`
   default) and `loadClerkJsScript.mjs` (`versionSelector(__internal_clerkUIVersion, "<ui version>")`).
   As of 2026-08 with `@clerk/clerk-react@5.61.9` / `@clerk/shared@3.47.8`
   those were clerk-js **6.27.1** and @clerk/ui **1.29.1**.
2. `npm pack @clerk/ui@<version>` in the scratchpad, untar, and grep
   `dist/ui-common_ui_*.js` for the namespace, e.g. `apiKeys:{`. The en-US
   defaults are a plain object literal in that chunk.
3. The per-component chunk (`dist/apiKeys_ui_*.js`) tells you which keys are
   actually rendered and how — e.g. whether a control is a native `<select>`
   (Maestro can only tap the first one on a page) or a custom popover.

`node_modules/@clerk/shared/dist/types/localization.d.ts` still has the full KEY
list and is the fastest way to see what a component can say; it just has no
values. Sanity check: if the key list in `@clerk/shared` has keys the strings
source lacks, the strings source is the wrong version.

Related: [[maestro-multi-select-unreachable]].
