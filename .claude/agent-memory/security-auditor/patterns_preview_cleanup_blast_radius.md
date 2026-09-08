---
name: patterns-preview-cleanup-blast-radius
description: preview-cleanup.yml Convex preview GC uses a TEAM-scoped token to delete a deployment name it extracts from PR-controlled preview HTML — could delete prod. The preview-only guard (name refusal + deploymentType check) is now in the workflow — keep it.
metadata:
  type: project
---

`.github/workflows/preview-cleanup.yml` (monorepo `neonbinder/neonbinder`, LIVE-PROD) added a `convex-preview-cleanup` job (NEO-preview-autogc, branch `jburich/neo-preview-autogc`) that GCs Convex preview deployments on PR close.

**Blast-radius finding (CRITICAL):** the job derives the deployment name `$name` from the PR's own Vercel preview HTML `<meta name="x-convex-url" content="%VITE_CONVEX_URL%">` (apps/web/index.html line 9), then `POST api.convex.dev/v1/deployments/$name/delete` with a **team-scoped** `CONVEX_ACCESS_TOKEN`. That token can delete ANY team deployment including prod and the shared dev deployment. A same-repo-branch PR author (write access) can hardcode the meta tag to prod's URL, close the PR, and delete prod. There is NO guard that the target is actually a preview.

**Why token-scope can't fix it:** Convex's Management delete endpoint rejects the deployment-scoped `CONVEX_PREVIEW_DEPLOY_KEY`; only PAT/team/project-OAuth tokens work. Even a project-scoped OAuth token still contains prod+dev (same project), so it can still delete prod. => a code-level preview-only guard is MANDATORY, not optional.

**Required guard:** before the delete, hard-refuse the known non-preview names (prod and shared dev — the names live in the private operational notes and in the workflow itself) AND verify deploymentType==preview via the API (fail closed). **Status 2026-09-08: both guards are implemented in `preview-cleanup.yml`.** `$name` is regex-bounded to `[a-z0-9-]+` so no classic shell injection, but the name-CHOICE is the attack.

**What's done RIGHT (keep):** uses `pull_request` (not `pull_request_target`) + `if: head.repo.full_name == github.repository` => fork PRs get no token (double-guarded). Job requests only `contents:read` + `deployments:read` (no id-token). Token never echoed; no `set -x`. best-effort (`continue-on-error`, `|| true`).

**Lower issues:** Vercel bypass secret is sent as a header to `$url` (from vercel[bot] deployment record) — add a `.vercel.app` host allowlist to prevent exfil if that record is ever spoofed. Response `$body` is echoed (low leak risk).

pr-pipeline.yml has the SAME resolve-name pattern but only READS (env set on the same preview) — no delete, so no guard there. preview-cleanup is the first to weaponize `$name` destructively.
