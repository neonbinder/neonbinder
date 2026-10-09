---
name: patterns-neo318-derived-copy-column
description: Audit checklist for a denormalised copy column on an entity row (NEO-318 players.alsoSportIds) and for an exported plain `*Impl` body split out of a gated public query
metadata:
  type: project
---

Two shapes from NEO-318 that will recur.

**Exported `fooImpl(ctx, args)` split out of a gated handler.** Convex only
registers exports wrapped in `query`/`mutation`/`action` (and internal twins);
a plain async export is not reachable over the wire, and `players.ts` already
exports many `(ctx, ...)` helpers. So the split is safe IF: the gate stays in
the registered handler (before the Impl call), the Impl takes no identity
argument it could trust, and grep shows no other non-test caller. The
publicFunctionAuth pin keeps pointing at the registered function, which is
what matters.

**Derived copy column (mirror of a side table).**
- Public shapes: strip it in the shared doc-to-public helper
  (`toPublicPlayer`) and re-add only where a validator names it; grep every
  `returns` that spreads the public validator and every raw-doc internal
  validator (`getInternal` needed the optional field).
- Writers: one writer, pinned by a grep test. The insert-block pin only
  catches the literal field name, not a `...doc` spread into an insert or
  patch, so grep inserts/patches for spreads too.
- Rollback: once any row carries the new field, redeploying the pre-change
  commit fails schema validation. A revert must be two-step (strip the field
  with an armed internal fill, then remove it from the schema) or keep the
  optional field and the internal validator while removing only the writer
  and reader. Say so in the PR body.
- Staleness is display-only only if no gate or membership check reads the
  copy; confirm the authority table is still what every check reads.

Related: [[patterns-public-function-auth-registry]], [[patterns-neo313-cross-sport-override]].
