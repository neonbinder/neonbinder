---
name: patterns-neo325-identity-only-and-twins
description: Forced-insert flags vs multi-id inserts, bounding upstream labels on notice rows, pinning internal id readers, best-effort reads after commit (NEO-325 re-audit)
metadata:
  type: project
---

- A client flag that forces an insert (`identityOnly`) bypasses only the name
  tier. Check that the identity guards cover EVERY id the insert allocates: the
  planner read `wireToIds()[0]` while the insert path slotted all ids, and
  `blockLink` ran only on the match path.
- A marketplace label persisted into a notice or status row needs the same
  `checkSelectorValue` / length bound as the store doors; `parseSelectOptions`
  is unbounded.
- A new internal query that takes a client-reachable row id and returns
  marketplace ids must be pinned as internal in `publicFunctionAuth.test.ts`.
- A read after commit inside an action's try block turns a committed write
  into a reported failure; make it best-effort.
- Agent memory that spells out third-party endpoint recipes (paths, bodies,
  headers) for reading a marketplace outside the adapter belongs in private
  operational notes, not the public repo.
