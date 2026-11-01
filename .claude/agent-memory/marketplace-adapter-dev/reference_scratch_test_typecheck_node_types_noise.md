---
name: scratch-test-typecheck-node-types-noise
description: A scratch tsconfig extending convex/tsconfig.json has no node types, so a test that reads a JSON fixture with readFileSync/__dirname reports TS2591/TS2304; that is the house pattern, not an error in your lines
metadata:
  type: reference
---

When typechecking new Convex test files with a scratch config
([[convex-test-files-are-not-typechecked]]), a test that loads a fixture the
house way (`readFileSync(join(__dirname, "__fixtures__", "x.json"))`, as
`searchQueryClamp.test.ts` does) reports `TS2591 Cannot find name 'node:fs'`
and `TS2304 Cannot find name '__dirname'`: convex/tsconfig.json carries no
`@types/node`. vitest runs it fine.

**How to apply:** treat exactly those three diagnostics as noise; judge the
rest. Do not add `types: ["node"]` to the convex tsconfig to silence them (it
is the deploy typecheck's config).

Also handy for pure lib tests that need real Convex ids (an SKU parse, a
checksum guard): `encodeId(tableNumber, bytes16)` from
`convex/lib/convexIdCodec.ts` mints valid ids; `encodeId(2 ** 31, …)` gives the
longest (37 chars).
