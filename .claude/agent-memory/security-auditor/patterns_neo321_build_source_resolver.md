---
name: patterns-neo321-build-source-resolver
description: NEO-321 generalised the NEO-312 parallel build to a server-resolved source (insert, or the set's isBase sibling); the traps are a resolver that THROWS inside a post-delete write page, a capped sibling read answering "exactly one", and guard pins that only exercise a deprecated arg alias
metadata:
  type: project
---

When a build/rebuild action stops taking its source from the client and
resolves it server-side from the target's shape and NB flags (good: the
public action's only arg is the target id), re-check three things:

1. **Where the resolver runs inside the write phase.** Re-resolving in every
   insert page (and refusing a moved source) is right, but if the refusal is a
   `throw ConvexError` and the delete pages already ran, the action dies with
   no `deletedCount` / lost-link classification: the partial wipe is
   unreported. The house shape is to return the page's existing `changed`
   sentinel so the action's `blocked(..., {deletedCount, ...})` path fires.
   Look for an operator door that can flip the resolved flag mid-run
   (`setBaseVariantType` for `isBase`).
2. **A capped sibling read that answers "exactly one".** `take(N)` then
   "filter flag, require length === 1" fails OPEN past the cap (a second
   flagged sibling beyond N is invisible). take(N + 1) and block on overflow,
   per [[patterns-neo296-transaction-bounds]].
3. **Arg renames with a deprecated alias.** The guards test usually keeps
   calling the old arg; the live client path (new arg, new target class) goes
   unpinned and the pin dies when the alias is removed. Ask for a case on the
   new arg and on the newly buildable target shape. See
   [[patterns_public_function_auth_registry]].

The 5,000-card cap is a doc count; a full-doc `take(5001)` of card rows is
bounded in practice by the 16 MiB read limit, so a huge source throws a raw
Convex error instead of the operator block (fail-closed, before writes).
