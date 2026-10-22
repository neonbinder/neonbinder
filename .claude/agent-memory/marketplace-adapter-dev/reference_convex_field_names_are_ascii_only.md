---
name: convex-field-names-are-ascii-only
description: Convex rejects any object field name outside printable ASCII in function args/returns (and documents), so a v.record keyed by a name OR a marketplace id (BSC slugs carry accents) fails the whole call on one character; send a [{ id, label }] / [{ key, value }] list instead
metadata:
  type: reference
---

`convex/values` `validateObjectField` throws "Field names can only contain
non-control ASCII characters" for any key with a char < 0x20 or >= 0x7f. It
runs on every value crossing a function boundary (args, return, `runAction`
results, stored docs), so `v.record(v.string(), …)` keyed by a NAME works in
tests with ASCII fixtures and then fails a whole real call on one "Ávila" or
"José". `v.record` itself does not warn.

**Marketplace ids are not safe keys either.** BSC slugs are not ASCII-only
(`topps-chrome-exposé` is a real one), and SportLots values are free text.
Only NB-minted keys are safe: Convex ids, slot keys (`b0`, `s0`), facet and
level names, fixed feature keys.

**How to apply:** never key an arg/returned/stored object by a name or any
user/marketplace string; send `v.array(v.object({ id, label }))` and build any
keyed lookup in memory on the receiving side. When the arg is a public
mutation an old SPA tab can still call, widen with a `v.union(array, record)`
for one release and read both through one helper rather than flipping the
shape (see `convex/lib/platformLabelPairs.ts`).

**Reproducing:** convex-test's `t.mutation`/`t.query` DO serialise ARGS, so a
test that passes an accented key reproduces the exact production error. Its
`t.action` does not serialise the top-level RETURN: pin a return with
`expect(() => convexToJson(out)).not.toThrow()` and an accented fixture.
Related: [[narrowing-convex-validator-is-a-runtime-break]].
