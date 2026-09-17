---
name: fe-imported-convex-modules-stay-env-free
description: convex/marketplaceResolvability.ts and convex/selectorSyncStore.ts are imported by React components, so they must never read process.env; operator flags are read in a Convex-only helper and passed in as options
metadata:
  type: project
---

Some `apps/web/convex/*.ts` modules are imported directly by the SPA
(`components/SetSelector/AttachSetsDialog.tsx` and `CardChecklist.tsx` import
`marketplaceResolvability`; `selector-sync-feedback.ts` imports
`selectorSyncStore`). Vite does not polyfill `process`, so a `process.env`
read added to one of those modules crashes the browser bundle.

**Why:** planning NEO-287 (pause SportLots logins) the obvious place to skip a
paused side was inside `resolvableSides`, which is pure by design. The env
read has to live in a Convex-only helper (e.g. `convex/marketplacePause.ts`)
and reach the pure module as an option (`resolvableSides(chain, { paused })`).

**How to apply:** before putting an env or runtime flag into any `convex/`
module, grep `components/ app/ src/ lib/` for imports of that module. If the
FE imports it, keep it pure and thread the value in from the caller.
