/**
 * Redacts the query string off any `storage.googleapis.com` URL found
 * anywhere inside `value` (NEO-148 security follow-up).
 *
 * GCS v4 signed URLs carry the entire bearer capability in their query
 * string (`X-Goog-Signature` et al) — anyone holding the URL can write to
 * that exact object path until it expires. Sentry's default PII scrubbing
 * operates on structured field NAMES ("password", "token", ...), not on
 * arbitrary query strings buried inside a URL, so an XHR breadcrumb, a
 * tracing span's `http.url`, or a Session Replay network entry for a
 * `storage.googleapis.com` request would all ship the live capability to
 * Sentry — and Replay flushes every ~5s while a 200-500MB upload is still in
 * flight, well before the object exists to check.
 *
 * Implemented as a generic stringify → replace → parse pass rather than
 * hand-enumerating `breadcrumb.data.url` / `span.data['http.url']` / etc:
 * the call sites (breadcrumbs, transaction spans, raw Replay rrweb frames)
 * don't share a schema — Replay in particular records its own internal
 * shape that changes across SDK versions — so matching on the URL text
 * itself, wherever it appears in the payload, is the only approach that
 * doesn't silently stop working on the next `@sentry/react` bump.
 */

const SIGNED_STORAGE_URL_RE = /(https:\/\/storage\.googleapis\.com\/[^\s"'?]*)\?[^\s"'&]*(?:&[^\s"'&]*)*/g;

export function scrubSignedStorageUrls<T>(value: T): T {
  const json = JSON.stringify(value);
  if (!json || !json.includes("storage.googleapis.com")) return value;
  return JSON.parse(json.replace(SIGNED_STORAGE_URL_RE, "$1?<redacted>")) as T;
}
