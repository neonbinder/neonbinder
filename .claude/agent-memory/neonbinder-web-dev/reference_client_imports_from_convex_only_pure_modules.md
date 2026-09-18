---
name: client-imports-from-convex-only-pure-modules
description: apps/web client code may import a convex/ module ONLY if it is pure (convex/lib, convex/features, selectorSyncMatch, platformSlots…); a bound exported from convex/teams.ts or players.ts cannot be imported by a component because that file imports _generated/server and would drag the whole backend graph into the Vite bundle — hand-copy the number with a "keep in step with" comment, as MAX_TEAM_NAME_LENGTH in TeamManagement.tsx does; or split the module (NEO-287 marketplacePause)
metadata:
  type: reference
---

A plan or brief that says "import `MAX_TEAM_ALIASES` from convex/teams.ts rather
than restating the number" cannot be followed literally from a component.

**Why:** `convex/teams.ts`, `players.ts`, `leagues.ts`, `entityReviewQueue.ts`
import `./_generated/server`, `./auth` and each other; a client import of any
of them pulls the server module graph into the browser bundle. The modules
components DO import from `convex/` (`lib/entityNearMatch`,
`features/listingLimits`, `selectorSyncMatch`, `platformSlots`,
`marketplaceResolvability`) are pure helpers with no server imports.

**How to apply:** when a component needs a server bound, either (a) skip the
client-side check entirely and let the server's `ConvexError` message render —
the house rule is that bounds are never copy anyway — or (b) hand-copy the
constant with a "keep in step with X in convex/…" comment (precedent:
`MAX_TEAM_NAME_LENGTH` in `components/admin/TeamManagement.tsx`,
`MAX_TEAM_FULL_NAME_LENGTH` in `EntityReviewWizard.tsx`). If a bound is needed
on both sides often, ask for it to be moved to a pure `convex/lib/*` module.

**Third option — split the module (NEO-287 precedent):** when a new Convex
module must both read `process.env` / declare a `query` AND hand the SPA a
vocabulary (constants, a parse function, a site→side map), put the pure
parts in `convex/lib/<name>.ts` and have `convex/<name>.ts` re-export them
next to the env readers and the query. Components import `convex/lib/...`;
server code imports `convex/<name>` and never notices the split. Grep the
lib file for `process` and `_generated` before returning — comments aside,
both must be absent.
