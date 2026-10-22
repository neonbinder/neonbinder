---
name: neo339-harness-link-and-parity-tests
description: NEO-339 setbuild harness link assertions (link-checks.ts + fixture), registry parity test placement, StepCheckError engine tests via world() tweak hook, planted-break loop
metadata:
  type: reference
---

- Live link checks for mcp-smoke/mcp-oneshot live in `tools/setbuild/link-checks.ts` (form, origin, depth, `resolveDrillPath` through an injected `resolveDrill`); `link-checks.fixture.ts` is a tiny id world + `knownResolver`. The harness runners take `resolveDrill`/`readCards` as REQUIRED options so a missing injection cannot silently skip a check; the CLI command builds them from its own `makeClient`.
- A test that imports the attention registry (React, `@/` paths) cannot sit under `tools/setbuild` (tools tsconfig has no `@/` alias; typecheck floods with errors). Put it under `components/SetSelector/*.test.tsx` and import the tool's functions by relative path. A `.test.ts` under `components/` is collected by nothing, so use `.tsx`.
- Engine StepCheckError tests (`runner/collect.test.ts`): `world(cards, tweak)` exposes the mutable `tree`; a handler can flip the tree mid-run (e.g. drop Base inside `getAncestorChain`) to reach the engine's own `findBaseVariantType` catch.
- Planted-break loop: back up to the scratchpad, a small python script that asserts the target string occurs once, run `vitest run components tools`, copy back, `cmp`. Breaks in `components/SetSelector/attention-rules.ts` go red in BOTH lanes (CardAttentionWalker.test.tsx plus tools attention tests).
- Use the Node in `.nvmrc` by PATH (`~/.nvm/versions/node/v24.3.0/bin`); the shell's default node differs.
- Concurrent builders edit tools files: a lone red in an unrelated file on the first full run may be a mid-edit transient; rerun before chasing.
