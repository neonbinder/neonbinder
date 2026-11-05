/**
 * NEO-415 — redacts the OAuth return's `code` and `state` query parameters
 * from anything headed to Sentry or PostHog.
 *
 * eBay sends the collector back to `/profile/ebay?code=…&state=…`. Since
 * NEO-434 `src/ebay-return-address.ts` takes those off the address before any
 * SDK starts, so this is the second layer, for wherever else they surface. A
 * navigation-timing entry keeps the address as it arrived, and Replay and
 * PostHog's recorder both copy those. The code is single use and short lived,
 * and the state is a one-time nonce, but neither belongs in a third party's
 * store.
 *
 * Same shape as `scrubSignedStorageUrls`: a stringify → replace → parse pass
 * over the whole payload, because the URL turns up under different keys in
 * every pipeline (`$current_url`, `request.url`, breadcrumb `to`/`from`). This
 * covers only what a hook is handed: Sentry Replay gives `beforeAddRecordingEvent`
 * rrweb custom events alone, and its Meta frame and `replay_event` get no hook,
 * which is why the address step exists. It is global, not keyed to the eBay
 * route: any `code=` or `state=` query value anywhere is redacted, plain or
 * percent-encoded (as in a nested return URL). The parameter name stays so the
 * shape of the URL is still readable.
 *
 * Like that scrub it throws on a payload JSON cannot represent, so whole Sentry
 * events go through `scrubEvent` in `src/sentry.ts` (NEO-434).
 */

// `?code=…` / `&state=…`, the value running to the next `&`, `#`, quote,
// whitespace or JSON escape.
const PLAIN_RE = /([?&])(code|state)=[^&#\s"'\\]*/g;
// The percent-encoded form, inside another URL's value: `%3Fcode%3D…` up to
// an encoded `&` (`%26`) or the end of that value.
const ENCODED_RE = /(%3F|%26)(code|state)%3D(?:%(?!26)[0-9A-Fa-f]{2}|[^&#\s"'\\%])*/gi;
const HINT_RE = /(?:[?&]|%3F|%26)(?:code|state)(?:=|%3D)/i;

export const REDACTED = "<redacted>";

export function scrubOAuthParams<T>(value: T): T {
  if (value === null || value === undefined) return value;
  const json = JSON.stringify(value);
  if (!json || !HINT_RE.test(json)) return value;
  const scrubbed = json
    .replace(PLAIN_RE, `$1$2=${REDACTED}`)
    .replace(ENCODED_RE, (_m, sep: string, name: string) => `${sep}${name}%3D${REDACTED}`);
  return JSON.parse(scrubbed) as T;
}
