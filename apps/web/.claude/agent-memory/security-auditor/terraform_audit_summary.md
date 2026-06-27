---
name: Terraform Infrastructure Audit Summary
description: Key security findings from neonbinder_terraform audit - TF deployer has projectIamAdmin+secretmanager.admin (effective owner), runtime/convex SAs have project-wide secret access, Cloud Run public with API key only
type: project
---

## Terraform Audit Summary (2026-03-18)

### HIGH Priority - Open
1. **TF deployer SA has effective project-owner access**: `projectIamAdmin` + `serviceAccountAdmin` + `secretmanager.admin`. Compromised TF workflow = total project takeover + mass credential exfiltration. WIF branch restriction is the only mitigation.
2. **Runtime SA** (`neonbinder-browser-runtime`) has project-level `secretAccessor` + `secretVersionManager` -- can read AND overwrite all secrets. Needs IAM Condition scoping by secret name prefix.
3. **Convex SA** (`neonbinder-convex`) same issue as #2.
4. **Deployer SA** has project-wide `storage.objectAdmin` -- can tamper with TF state bucket. Needs bucket-level scoping.
5. **Cloud Run public access** with single static `INTERNAL_API_KEY` -- no rotation, no rate limiting at infra level. Single point of failure for credential-handling service.

### MEDIUM Priority - Open
- No CMEK on TF state bucket (GCS backend `encryption_key: null`)
- No secret rotation policy on `internal-api-key`
- No `prevent_destroy` on critical resources (SAs, secrets)
- `.terraform.lock.hcl` gitignored -- provider supply chain risk
- Google provider pinned to legacy 4.x (`~> 4.0`)
- TF plan output posted to PR comments may leak resource metadata

### Confirmed Good Practices
- SA key creation disabled by org policy
- WIF for CI/CD (no long-lived keys)
- Developer access via impersonation only
- Audit logging enabled for IAM and Secret Manager (ADMIN_READ, DATA_WRITE, DATA_READ)
- Deployer `serviceAccountUser` scoped to specific SAs, not project-wide
- Separate dev/prod GCP projects with separate state prefixes

### Architecture Notes
- Dev project: `neonbinder-dev-io`, Prod project: `neonbinder-484017`
- TF state bucket: `neonbinder-terraform-state` (shared, prefixed by env)
- WIF pool: `github-actions` with two providers (browser repo + terraform repo)
- Browser repo WIF restricted to `refs/heads/main` (prod) / `refs/heads/develop` (dev)

**How to apply:** When reviewing convex/adapters/ or browser service code, assume any SA compromise exposes ALL secrets project-wide. Treat INTERNAL_API_KEY as a critical single-point-of-failure credential.
