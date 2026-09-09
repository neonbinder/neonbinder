---
name: patterns-gcs-signed-url-bucket
description: How to add a new dev+prod GCS bucket in neonbinder_ioc for direct client uploads via Convex-minted v4 signed POST policies (not signed PUT URLs — a security audit forced that switch), the Convex/testing gotchas, and the Sentry/IAM follow-ups a signed-upload feature needs (NEO-148 placeholder-uploads bucket).
metadata:
  type: project
---

Built as NEO-148 ("Placeholders 1/5: GCS bucket + signed-URL direct upload
path"). Terraform in
`worktrees/neo-148-placeholder-bucket-terraform`
(branch `neo-148-placeholder-bucket`, off `develop`), monorepo half in
`worktrees/neo-148-signed-upload`
(branch `neo-148-signed-upload`, off `main`). Both implemented + tested
locally, NOT pushed/merged/applied as of 2026-08-13 — this is a build record,
not a "shipped" note.

## Terraform bucket pattern (main.tf, flat file, no modules)

Two existing buckets to copy from: `google_storage_bucket.neonbinder_prizes`
(prod-only naming `neonbinder-prizes-${var.gcp_project_id}`, ~main.tf:610) and
`google_storage_bucket.preprocess_fixtures` (dev-only, hardcoded
`neonbinder-dev-preprocess-fixtures` name, ~main.tf:1344). For a bucket that
must exist in **both** dev and prod, use the prizes bucket's parameterized
naming style (`"neonbinder-<purpose>-${var.gcp_project_id}"`) — never the
preprocess-fixtures style that bakes `-dev-` into the literal name, since that
breaks in prod.

Gating var convention: `count = var.create_<name>_bucket ? 1 : 0`, default
`true` if the bucket must exist everywhere, `false` if env-specific (then set
`true` explicitly in only the relevant `.tfvars`). All IAM grants on the
bucket use the same `count` gate and index `[0]`.

`preprocess_runtime` (`google_service_account.preprocess_runtime`, defined
~main.tf:1083) is the SA name for anything the preprocess Cloud Run service
needs — not "preprocess" or "preprocess_service_account". Forward
references to it from earlier in the file are fine; Terraform resolves by
dependency graph, not file order.

tf-deployer already holds project-level `roles/storage.admin` (main.tf:850,
a `google_project_iam_member`) — never add a bucket-scoped grant for it, it's
redundant.

CORS block (no precedent anywhere in this repo before NEO-148): GCS CORS
`origin` entries must be exact strings, no subdomain wildcards, so a
`*`-origin with `method = ["PUT","OPTIONS"]` is the only workable choice when
the real client is a Vercel preview (one unpredictable origin per
deployment). This is safe specifically because the signed URL — not
same-origin — is the actual authorization boundary; CORS with `*` here grants
nothing without a valid per-object signature. Don't reach for a wildcard CORS
origin as a default elsewhere without that same signed-URL-is-the-boundary
justification.

`terraform init -backend=false` + `terraform validate` run fine with **no
GCP credentials** — always try this before declaring Terraform unverifiable.
`terraform fmt -recursive` will reformat `.tfvars` column alignment; run it
and let it realign rather than hand-aligning `=` signs.

## Convex signed-URL action gotchas

1. **`getSignedUrl` field is `action`, not `method`.** The public
   `file.getSignedUrl()` config type (`@google-cloud/storage` v7,
   `src/file.d.ts` `GetSignedUrlConfig`) takes
   `action: 'read'|'write'|'delete'|'resumable'` — that's the field name to
   use, separate from the lower-level signer's `method: 'GET'|'PUT'|...`.
   Confirmed by reading the installed package's `.d.ts`, not assumed.

2. **convex-test's `import.meta.glob` module registry is broken for test
   files living inside `convex/adapters/`.** Every existing convex-test
   action test in this repo lives directly under `convex/` and globs
   `"./**/*.*s"`. Point the same glob from inside `convex/adapters/` (e.g.
   `"../**/*.*s"`) and every `t.action(api.adapters.X.Y, ...)` call fails
   with `Could not find module for: "adapters/X"` — the relative-path keys
   the glob produces don't match what convex-test's function-path resolver
   expects (it wants paths relative to the `convex/` root specifically).
   Fix: put the test file at `convex/<name>.test.ts` (not
   `convex/adapters/<name>.test.ts`) even though the source lives in
   `adapters/`, and keep the glob as `"./**/*.*s"`. This mirrors
   `[[reference_vitest_count_not_just_passed]]` from the top-level memory —
   an uncollected/misconfigured convex-test file doesn't error, it just
   throws a confusing runtime error that looks unrelated to test placement.

3. **A freshly created worktree has no `CONVEX_DEPLOYMENT` configured**, so
   `npx convex codegen` (itself genuinely read-only — its own `--help` says
   "This doesn't modify the code running on the deployment") fails with "No
   CONVEX_DEPLOYMENT set". This leaves the checked-in
   `convex/_generated/api.d.ts` stale (missing the new function) after
   adding a new Convex file in a scratch worktree — `tsc --noEmit` will
   report `Property 'X' does not exist` on `api.adapters.X...` references.
   This does **not** fail the actual CI gate: `web-unit` in
   `.github/workflows/pr-pipeline.yml` runs only `npm run test:unit`
   (vitest, esbuild-transpiled, no type checking), no `tsc`/codegen step.
   In real dev flow, `_generated/` gets regenerated + committed automatically
   by whoever has `npx convex dev` running locally, or by the Vercel prod
   build's `convex deploy` step. Don't try to work around missing
   deployment credentials to force codegen in a throwaway worktree — just
   flag the stale generated types as a pre-merge follow-up in the report.

See also `[[reference_e2e_self_contained_per_flow]]`-style top-level memory
on convex-test glob patterns generally (none existed yet for a
sub-`convex/adapters/` action test before this).

## Security-audit round (same day, 2026-08-13): signed PUT → signed POST policy

A security audit (approved with conditions) on the v1 design above forced a
rework from a v4 signed **PUT URL** to a v4 signed **POST policy**
(`bucket.file(...).generateSignedPostPolicyV4()`). Findings + fixes, useful
for the next signed-upload feature:

1. **A signed PUT URL cannot cap object size; a signed POST policy can.**
   `generateSignedPostPolicyV4({ conditions: [["content-length-range", 0,
   MAX_BYTES]], fields: {...} })` — GCS enforces the range server-side. This
   reframes "client-side size check is advisory only" from an accepted gap
   into a solved problem; don't ship the PUT-URL version as "good enough" if
   a POST policy is on the table.

2. **Whatever you pass in `fields` gets an automatic exact-match `conditions`
   entry — you don't need to duplicate it.** Read from the installed
   `@google-cloud/storage` package's compiled `file.js`
   (`generateSignedPostPolicyV4`): it does
   `Object.entries(fields).forEach(([key, value]) => conditions.push({[key]:
   value}))` before signing. So `fields: {"Content-Type": "application/zip",
   "x-goog-if-generation-match": "0"}` is sufficient to both (a) require the
   client send those exact values and (b) bind them into the signature —
   `conditions` only needs entries for things that AREN'T exact-match, like
   `content-length-range`.

3. **`x-goog-if-generation-match: 0` is the write-once mechanism**, and with
   a POST policy it's a `fields` entry (multipart form field), not an HTTP
   request header — this matters because it means it is NOT subject to CORS
   preflight and does NOT belong in the bucket's CORS `response_header` list
   (that list controls `Access-Control-Expose-Headers` on the *response*,
   unrelated to request form fields). A reviewer/coordinator asking for it
   to be added to `response_header` was wrong on the mechanics; pushed back
   with the `generateSignedPostPolicyV4` source as evidence rather than
   applying it silently — this is the kind of "no-op that misstates the
   trust model" the same audit round flagged elsewhere (see #6 below), so
   it's worth catching in either direction.

4. **Client-side mechanics for a POST policy vs PUT URL differ
   completely.** `xhr.open("PUT", url)` + `setRequestHeader("Content-Type",
   ...)` + `xhr.send(blob)` becomes `xhr.open("POST", url)` + build a
   `FormData` with every `fields` entry appended **before** the file field
   (GCS ignores any form field appended after `file`) + `xhr.send(formData)`
   with **no manual Content-Type header** (the browser must generate its own
   multipart boundary; setting it by hand breaks the request). Success
   response for a POST policy is `204` by default, not `200`.

5. **Sentry (`@sentry/react` v10+) can leak a signed URL's query string
   through three independent pipelines**, each needing its own hook:
   `beforeBreadcrumb` (XHR/fetch breadcrumbs), `beforeSendTransaction`
   (browserTracingIntegration's auto spans, `http.url`), and
   `replayIntegration({ beforeAddRecordingEvent })` (Session Replay's raw
   rrweb frames — a *different* internal shape from the other two, and it
   changes across SDK versions). Sentry's default PII scrubbing matches
   structured field **names** ("password", "token"), never arbitrary query
   strings embedded in a URL value, so none of it catches
   `?X-Goog-Signature=...` automatically. The robust fix across all three
   heterogeneous shapes: a single generic `JSON.stringify → regex-replace →
   JSON.parse` scrub helper applied at all three hook points, rather than
   hand-enumerating each subsystem's field path (`breadcrumb.data.url` vs
   `span.data['http.url']` vs whatever Replay's frame shape happens to be
   this SDK version). Also: Replay flushes ~every 5s mid-upload, so the
   capability reaches Sentry well before the object exists — "it's already
   uploaded by the time anyone could misuse the URL" is not a valid
   mitigation.

6. **A misattributed leak vector in a security comment is worth catching
   even when the fix itself is right.** V1 justified the 15-minute signed-URL
   TTL by saying the capability could leak "via a browser history entry" —
   plausible-sounding but wrong: an XHR request never creates a history
   entry (only top-level navigation does). The real vector was client-side
   observability tooling (Sentry, see #5). A plausible-but-wrong rationale in
   a security comment is worse than no comment, since it points the next
   reader's threat model in the wrong direction.

7a. **After the audit, the user approved pulling the ownership-record table
   into NEO-148 itself** (`placeholderJobs`, rather than deferring to
   NEO-151): `{jobId, userId, objectPath, createdAt, status}`, indexed
   `by_job` and `by_user`, written via an `internalMutation` in a plain
   (non-`"use node"`) sibling file (`convex/placeholderJobs.ts`) and called
   from the node action via `ctx.runMutation(internal.placeholderJobs.X,
   ...)` — node actions have no `ctx.db`, this indirection is required, not
   a style choice. The row's entire purpose is enforceability *after* mint
   time: bucket-wide `objectViewer` on two SAs means `jobId` (opaque,
   looked-up server-side) is the only thing standing between that grant and
   a cross-user read oracle, so the table comment says in block caps that NO
   function may ever accept `objectPath` as an argument — write that
   directly on the table definition, not just in a design doc, since it's
   the next implementer (NEO-151/152) who needs to see it before they write
   the first consumer.

7b. **A schema change needs `convex/_generated/dataModel.d.ts` regenerated
   to typecheck**, same `npx convex codegen` problem as `api.d.ts` (see #3
   above) — expect `tsc --noEmit` to report `Property 'placeholderJobs' does
   not exist on type ...` until someone with real deployment credentials
   regenerates it. Don't work around this (e.g. hand-editing the generated
   file) — flag it and move on; vitest doesn't need it since it doesn't
   typecheck.

8. **Don't apply an IAM-condition tightening blind to a project-level grant
   a live CI/CD deploy pipeline depends on**, even when asked to. Two
   pre-existing `roles/storage.objectAdmin` project-level grants (for the
   browser and preprocess deployer SAs, meant for GCR image push/pull) became
   over-broad the moment a user-content bucket joined the same project — but
   scoping them via an IAM `condition` block requires a real `terraform
   plan`/`apply` against live credentials to verify the CEL condition syntax
   and bucket-name-prefix assumption are actually correct (e.g. is the
   legacy `artifacts.<project>.appspot.com` bucket still what
   `docker push gcr.io/...` touches, or did the Artifact-Registry-backed
   `gcr.io` repo move storage internally?). Landing an unverified condition
   on a grant a deploy pipeline depends on risks a silent 403 on the next
   push. When a coordinator's instructions explicitly offer an escape hatch
   ("if too risky to apply blind, leave alone + comment"), take it and write
   the exposure + recommended follow-up directly on the resource rather than
   guessing at conditional-IAM syntax with no way to verify it.
