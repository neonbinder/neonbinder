---
name: users-table-is-never-written
description: convex `users` table has no writer, so never join on it for a name; profile names come from publicProfiles, everything else from Clerk via adminUsers.adminResolveOwnerLabels
metadata:
  type: reference
---

The `users` table in `convex/schema.ts` (email, name, clerkUserId, index
`by_clerk_user_id`) has no insert or patch anywhere in `convex/`. Nothing
copies Clerk into it, so a lookup there always comes back empty. Do not add
one as a fallback.

Every `ownerId` / `userId` string in NB tables is the Clerk subject
(`requireSignedIn` returns `identity.subject`). A person's name comes from:
- `publicProfiles` (`by_user`): displayName, username. Only collectors who
  set up a public profile have one.
- Clerk: `adminUsers.adminResolveOwnerLabels`, an admin action that takes a
  distinct id set in one Backend API call. It answers an id with **itself**
  when Clerk has nothing or the call fails, so "label === id" means no name.

**How to apply:** the query returns a profile label plus `named: boolean`
(e.g. listingSync `adminSyncOwners`/`adminSyncStatus`). The page calls the
action once per id that is not named, through the stable
`useConvex().action` (not `useAction`, whose identity changes every render).
It caches the answers by id, uses one only when it differs from the id, and
otherwise shows a plain unnamed label with a short id suffix. The raw id is
never shown. Examples: app/admin/sync-status/page.tsx and
app/pipeline-runs/page.tsx.
