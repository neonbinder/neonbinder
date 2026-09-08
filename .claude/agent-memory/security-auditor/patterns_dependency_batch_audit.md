---
name: dependency-batch-audit
description: How to security-audit a Dependabot/dep-bump batch (npm + SHA-pinned Actions) in the monorepo before it becomes a PR — scope, commands, red-flag checks
metadata:
  type: reference
---

Recurring task in monorepo neonbinder/neonbinder: periodic dependency batches (e.g. NEO-86 "deps-batch-2026-07") bundle npm bumps + GitHub Actions SHA re-pins on one branch, audited before opening a PR. Scope = supply-chain/provenance ONLY, not product code review.

**How to apply — run these against `git diff origin/main..HEAD`:**

1. **Action SHA re-pins (CRITICAL check).** Each `uses: owner/repo@<sha> # vX.Y.Z` — verify the pinned SHA actually equals the claimed tag's commit:
   `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha` (this deref's annotated tags to the commit). MISMATCH = supply-chain compromise = CRITICAL/FAIL. Loop all of them in one bash block.

2. **npm audit** in each changed dir (`apps/web`, `services/browser`). Key nuance: audit reflects the POST-bump lockfile, so cross-check whether flagged vuln subtrees are actually TOUCHED by the batch. If the vulnerable packages (e.g. undici via @vercel/node, uuid/gaxios/teeny-request/retry-request via @google-cloud/storage, jsdiff) are NOT among the bumped/added lockfile entries, the advisories are PRE-EXISTING on main, not introduced by the batch → don't fail the batch for them (note as informational, separate remediation ticket).

3. **Lockfile provenance** (grep the `^+` added lines):
   - resolved URLs → all must be `registry.npmjs.org` (flag any other host)
   - integrity → all `sha512-` (flag md5/sha1)
   - `hasInstallScript` newly added → new postinstall/preinstall lifecycle = investigate
   - newly-added `node_modules/...` keys → eyeball for typosquats (real batches pull only well-known deps: brace-expansion, minimatch, chalk, cliui/yargs deps, dotenv-expand, @sentry/conventions, etc.)

4. **Secret/config drift:** `git diff --stat` must show ONLY package.json / package-lock.json / .github workflow files. Grep body for secret patterns; note `id-token: write` is a legit OIDC permission, NOT a secret.

NEO-86 result (2026-07-07): all 5 SHAs matched, all lockfile URLs registry+sha512, no new install scripts, no typosquats, no secrets, audit findings all pre-existing → PASS. See also [[reference_dependabot_ci_secrets_maintainer_push]] (Dependabot runs are denied Actions secrets → deploy/E2E gate can't pass until a maintainer pushes to the branch).
