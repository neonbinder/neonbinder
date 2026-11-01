---
name: e2e-only-code-ships-in-prod-bundle
description: An E2E-only branch gated by a helper function (isE2E()) from another module is NOT folded by the Vite/rolldown build, so the gated module ships dead to real users; inline import.meta.env in the branch to tree-shake it. How to measure.
metadata:
  type: pattern
---

For a "no UI change" diff (observability, E2E diagnostics), the impeccable
performance dimension is the real question: does it reach real users' bundle
or runtime?

- `lib/observability/e2e-diagnostics.ts` exports `isE2E = () =>
  import.meta.env.VITE_CLERK_TESTING_ENABLED === "true"`. Vite replaces the
  env value, but rolldown does NOT inline the call across modules, so
  `if (!isE2E()) return ...; <E2E-only code>` keeps the E2E code, and every
  module it references, in the production bundle (dead at runtime).
- Writing the condition inline at the branch
  (`if (import.meta.env.VITE_CLERK_TESTING_ENABLED !== "true") return ...`)
  folds it and tree-shakes the module. Measured on NEO-409's hang detector:
  about 4.5 KB minified (~2 KB gzip) removed from the main chunk.
- Measure, don't guess: `env -u VITE_CLERK_TESTING_ENABLED npx vite build
  --outDir <scratch>/dist` (the cloud env exports the flag as true, so unset
  it), then grep the chunk for a unique string of the E2E module. To try a fix
  without touching the worktree, tar-copy apps/web minus node_modules to the
  scratchpad, symlink node_modules, edit the copy and rebuild.
- Severity: P3 (bytes only, no runtime cost, nothing visible) unless the gated
  code pulls a large dependency.
