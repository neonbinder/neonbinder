---
name: per-user-e2e-tables-reset-in-bootstrap-not-the-global-reset
description: A new per-user table (owned by the Clerk subject) must join resetMyTestState, which the E2E bootstrap runs per user; the global set-builder reset alone leaves the same test user's rows behind between desktop and mobile passes
metadata:
  type: reference
---

NEO-358 (2026-10-23): collector tables (`collectionCopies`,
`collectionContainers`, `collectionBuildingSets`) are owned by the Clerk
subject. The desktop and mobile E2E passes sign in as the same user, and the
catalog is re-seeded between them with new card ids, so leftover copies would
point at cards that no longer exist.

**How to apply:** any plan adding a per-user table lists two reset additions:
`resetMyTestState` in `convex/testing.ts` (the caller's own rows, children
before parents, plus its returns validator and `app/testing/reset/page.tsx`)
AND the global reset drain if the rows hold catalog ids. A spec that writes
such rows should also clean up after itself. Related:
[[transient-side-table-checklist]].
