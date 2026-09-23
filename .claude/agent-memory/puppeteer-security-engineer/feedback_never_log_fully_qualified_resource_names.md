---
name: never-log-fully-qualified-resource-names
description: services/browser log lines carry the BARE secret id and a version ordinal, never projects/<project>/secrets/<id>[/versions/N] — the fully-qualified form spends the GCP project identifier for nothing
metadata:
  type: feedback
---

A log line in `services/browser` names a secret by its **bare id**
(`<site>-credentials-<clerkUserId>`) and a version by **id + ordinal**
(`<secretId>/versions/<N>`). It never passes a fully-qualified Secret Manager
resource name — `projects/<project>/secrets/<id>` or that plus
`/versions/<N>` — as a log argument.

**Why:** the fully-qualified form's only extra content is the GCP project
identifier, and the project is already a property of the deployment the log
line came from, so it is a pure cost. NEO-294 started with a raw gRPC error
carrying exactly that project identifier plus a per-user secret id escaping
onto an HTTP response body; narrowing the log lines is the same leak closed at
the other end. Jason decided this explicitly in NEO-294 when it was put to him
as a posture question — the file had previously pinned the OPPOSITE position in
two tests ("version resource names ARE safe to log and are useful"), so this
reverses a documented house call rather than merely tightening an unexamined
one.

**How to apply:** when adding or editing a log line near Secret Manager, pass
the bare id; if the line is about a specific version, keep the **ordinal** —
telling versions apart is the entire reason those lines exist, and a line that
names only the secret cannot be acted on. The helper is `shortVersion(secretId,
versionName)`. A private method that needs to log therefore takes BOTH the
resource name (to address the API) and the bare id (the only thing it may log)
rather than parsing one out of the other — that way a future caller cannot hand
it a name without also handing it the id it is allowed to print.

Two things this does NOT cover, both deliberate:

- **A caught error's own `message`.** Those are logged as `err.message` and a
  real gRPC message embeds the resource name. Scrubbing it would mean a regex,
  and the NEO-294 fix was explicitly "replace the error, never regex it".
  The message stays; see the Private-notes posture on retention.
- **The five prune log lines' error text**, for the same reason.

Related: [[secret-manager-has-no-upsert]], [[secret-version-keep-one]],
[[adapter-error-string-is-body-and-classifier]].
