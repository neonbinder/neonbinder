/**
 * Redacts signed upload and read capabilities found anywhere inside `value`:
 * first the query string off any `storage.googleapis.com` URL (NEO-148 security
 * follow-up), then the shapes listed at the end of this note (NEO-434).
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
 *
 * The pass throws on anything JSON cannot represent, such as a circular object.
 * A Sentry event's `sdkProcessingMetadata` is one, so whole events go through
 * `scrubEvent` in `src/sentry.ts`, which keeps it out (NEO-434).
 *
 * NEO-434 widened it past Google's host. Copy-photo uploads PUT to a signed R2
 * URL and request photos POST to a one-time Convex `?token=` URL, and a span's
 * `http.query` holds the query with no host at all, so the parameter names are
 * matched wherever they appear, plain or percent-encoded. It also takes the R2
 * account id out of the host and the copy-photo token out of a path: that token
 * is the bearer for `/copy-photo/<token>/<size>` (`convex/copyPhotos.ts`).
 *
 * Every pattern stops at a backslash. This runs on JSON text, where a quote
 * inside a string is `\"`, and eating the backslash leaves JSON that will not
 * parse.
 */

// A Google URL loses its whole query, so older `GoogleAccessId`/`Signature`
// forms go too, not just the parameters named below.
const STORAGE_QUERY_RE = /(https?:\/\/(?:[^\s"'\\/?]+\.)?storage\.googleapis\.com\/[^\s"'\\?]*)\?[^\s"'\\]*/gi;
// `?token=…`, `&X-Amz-Signature=…`, or a bare query. `csrf_token=` is not `token=`.
const PARAM_RE = /(?<![\w-])(x-(?:goog|amz)-[\w-]+|token)=[^&#\s"'\\]*/gi;
// The percent-encoded form, inside another URL's value, up to an encoded `&`.
const ENCODED_PARAM_RE =
  /(%3F|%26|(?<![\w%-]))(x-(?:goog|amz)-[\w-]+|token)%3D(?:%(?!26)[0-9A-Fa-f]{2}|[^&#\s"'\\%])*/gi;
// `<account>.r2…`, `<bucket>.<account>.r2…` or `<account>.eu.r2…`, bare or as
// the encoded `%2F%2F<account>…`. Labels are bounded so a long run of letters
// elsewhere in the payload stays cheap.
const R2_HOST_RE = /(%2F)?(?:[a-z0-9-]{1,63}\.){1,4}?((?:(?:eu|fedramp)\.)?r2\.cloudflarestorage\.com)/gi;
// `newToken` in `convex/copyPhotos.ts`: exactly 32 lowercase hex characters.
const COPY_PHOTO_TOKEN_RE = /(copy-photos?(?:\/|%2[Ff]))[0-9a-f]{32}(?![0-9a-f])/g;

const REDACTED = "<redacted>";

export function scrubSignedStorageUrls<T>(value: T): T {
  const json = JSON.stringify(value);
  if (!json) return value;
  const scrubbed = json
    .replace(STORAGE_QUERY_RE, `$1?${REDACTED}`)
    .replace(PARAM_RE, `$1=${REDACTED}`)
    .replace(ENCODED_PARAM_RE, `$1$2%3D${REDACTED}`)
    .replace(R2_HOST_RE, `$1${REDACTED}.$2`)
    .replace(COPY_PHOTO_TOKEN_RE, `$1${REDACTED}`);
  return scrubbed === json ? value : (JSON.parse(scrubbed) as T);
}
