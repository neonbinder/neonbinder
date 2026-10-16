---
name: convex-field-names-are-ascii-only
description: Convex rejects any object field name outside printable ASCII in function args/returns (and documents), so a v.record keyed by a player/team/league name fails the whole call on one accent; return a [{ key, value }] list instead
metadata:
  type: reference
---

`convex/values` `validateObjectField` throws "Field names can only contain
non-control ASCII characters" for any key with a char < 0x20 or >= 0x7f. It
runs on every value crossing a function boundary (args, return, `runAction`
results, stored docs), so `v.record(v.string(), …)` keyed by a NAME works in
tests with ASCII fixtures and then fails a whole real call on one "Ávila" or
"José". `v.record` itself does not warn.

**How to apply:** never key a returned/stored object by a name or any
user/marketplace string; return `v.array(v.object({ key, value }))` and build
the keyed object on the consumer side. Records keyed by ids (Convex ids,
marketplace numeric ids, slot names) are fine. convex-test's `t.action` does
not serialise the top-level return, so it will NOT reproduce the failure: pin
it with `expect(() => convexToJson(out)).not.toThrow()` and an accented name
in the fixture. Related: [[narrowing-convex-validator-is-a-runtime-break]].
