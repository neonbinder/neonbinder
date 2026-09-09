---
name: vercel-build-runs-convex-typecheck
description: apps/web Vercel build = convex deploy + vite build; why local vite build can pass while Vercel fails, and how to reproduce the convex typecheck locally
metadata:
  type: reference
---

The `apps/web/vercel.json` buildCommand is:
`npx convex deploy --cmd-url-env-var-name VITE_CONVEX_URL --cmd 'npm run build'`

So a Vercel deploy does TWO things `npm run build` (plain `vite build`) does NOT:
1. **Convex deploy** — claims/pushes a Convex (preview) deployment AND runs a full
   TypeScript typecheck of the `convex/` functions via `tsc -p convex/tsconfig.json`.
   `vite build` uses esbuild and does NOT typecheck, so convex type errors never fail
   `npm run build` locally — only the Vercel `convex deploy` step catches them.

**How to apply:** When "local `vite build` is green but Vercel is red", don't assume the
dep is fine. Reproduce the two missing checks locally:
- `npx tsc -p apps/web/convex/tsconfig.json --noEmit` (the convex deploy typecheck; that
  tsconfig excludes `_generated` and `*.test.ts`).
- Read the actual Vercel build log (Vercel MCP `get_deployment_build_logs`, teamId
  `neon-binder`, errorsOnly) — the failure may be infra, not code. Seen 2026-06-29:
  `DeploymentQuotaReached: deployment quota of 40 has been reached` at
  `claim_preview_deployment` — a Convex **preview** quota cap that blocks EVERY PR's
  Vercel deploy regardless of the diff (orchestrator must GC previews / raise the plan).
  This is the real reason a batch of dependabot PRs all show "Vercel: fail".

Related: [[eslint-flat-config-skips-tsx]].
