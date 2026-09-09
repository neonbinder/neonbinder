---
name: reference_convex_management_api
description: Convex Management REST API — delete deployments, required token type, endpoint, and limitations of existing deploy keys
metadata:
  type: reference
---

## Convex Management API: Delete Deployment

Endpoint (confirmed in `api.convex.dev/v1/openapi.json`):

```
POST https://api.convex.dev/v1/deployments/{deployment_name}/delete
Authorization: Bearer <team_access_token_or_PAT>
Content-Type: application/json
Body: {}
```

Response codes: 200 = deleted, 404 = not found (already GC'd).

**Auth scope required:** PAT, OAuth Team Token, **Team Token**, or OAuth Project Token.
The `CONVEX_PREVIEW_DEPLOY_KEY` (deployment-scoped preview deploy key) is NOT accepted — it's not in the Management API security schemes.

**How to create a Team Access Token:** `dashboard.convex.dev` → Team Settings → Access Tokens → Create. Not tied to an individual user account (preferred for CI).

**Secret name used in repo:** `CONVEX_ACCESS_TOKEN` (does not exist yet as of 2026-06-30 — must be added before the cleanup workflow is effective).

## Convex Preview Deployment GC Behavior

- Auto-expiry: **5 days** (free plan), 14 days (Professional+).
- Branch deletion does NOT trigger Convex GC — expiry is purely time-based.
- Team quota: **40 preview deployments** hard cap → `DeploymentQuotaReached`.
- CLI has no `delete` subcommand (`npx convex deployment` only: select/create/token).

## Deployment Name Resolution

The Convex deployment name (for the API path) is the `convex.cloud` subdomain extracted from the `x-convex-url` meta tag in the Vercel preview HTML. Pattern used in both `pr-pipeline.yml` and `preview-cleanup.yml`:

```bash
html=$(curl -sS -H "x-vercel-protection-bypass: $BYPASS" "$VERCEL_URL/")
cloud=$(printf '%s' "$html" | grep -oE 'name="x-convex-url" content="[^"]*"' | grep -oE 'https://[a-z0-9-]+\.convex\.cloud' | head -1)
name="${cloud#https://}"; name="${name%.convex.cloud}"
```

Vercel preview URLs stay live after PR close, so this resolution works in cleanup workflows.
