---
name: setbuild-cannot-import-react-fixers
description: tools/setbuild (code AND its tests) must not import SetSelector React modules; tools tsconfig has no `@/` paths so `npm run typecheck` goes red even though vitest passes. Move the pure piece into a React-free SetSelector module both sides import; never mirror it.
metadata:
  type: reference
---

`tools/setbuild/tsconfig.json` is part of the `npm run typecheck` gate and
includes its `*.test.ts` files, but it declares no `@/` path alias. Importing a
SetSelector React module (a fixer, `cardAttentionRegistry.ts`,
`CardAttentionWalker.tsx`) from tool code or a tool test pulls its `@/...`
imports into that program: `TS2307 Cannot find module '@/...'` across dozens of
unrelated components. Vitest still passes (it has the alias), so the break only
shows at the typecheck gate.

Pure `.ts`/`.tsx` modules that import only relative paths are fine
(`card-attention.ts`, `TitleLengthMeter.tsx`, `useTitlePreview.ts`,
`drill-url.ts`).

**How to apply:** when the tool needs a rule or string that lives inside a React
module, MOVE it into a pure, relative-import-only module under
`components/SetSelector/` (e.g. `attention-rules.ts`, `card-attention.ts`), have
the React module import and re-export it, and import that module from the tool
by relative path. The coordinator rejected the first approach (a mirrored copy
in the tool, pinned by a `components/*.test.tsx` parity test): one copy beats a
copy plus a guard.

Related trap: `CardAttentionWalker.unknownKind.test.tsx` `vi.mock`s
`./card-attention` WHOLESALE, so any new export the walker calls at render must
be added to that mock (use `importOriginal`), or the test fails with
"No X export is defined on the mock".
