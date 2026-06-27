// Pure helper (no node-only deps) so it can be unit-tested in the edge-runtime
// vitest project that covers `convex/**`. Imported by credentials.ts.
//
// Cloud Run tagged-revision URLs (the per-PR browser-service previews) look like
//   https://pr-<N>---neonbinder-browser-<hash>-uc.a.run.app
// Requests must be SENT to that tagged host to reach the PR revision, but Cloud
// Run IAM validates the OIDC token's audience against the *base* service URL,
// not the tagged host (see neonbinder_browser/tests/integration/_helpers.mjs).
// So when the target is a tagged host of OUR browser service, mint the token for
// the base origin — everything after the first `---` tag separator. Every other
// URL (plain service URL, loopback dev, any unrecognized host) is returned
// verbatim so it flows through the normal auth path and fails closed.

// The base host of the neonbinder-browser Cloud Run service in us-central1
// (`uc`), for either env: dev `...-xxlo66yxuq-uc...`, prod `...-qkqlka2ioa-uc...`.
// Binding to this pattern (rather than stripping any `---`-containing run.app
// host) means a crafted/unexpected host can never coerce us into minting an
// OIDC token for an attacker-named audience.
const BROWSER_SERVICE_BASE_HOST = /^neonbinder-browser-[a-z0-9]+-uc\.a\.run\.app$/;

export function oidcAudienceFor(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return url;
  }
  const sep = host.indexOf("---");
  if (sep === -1) return url;
  const baseHost = host.slice(sep + 3);
  if (!BROWSER_SERVICE_BASE_HOST.test(baseHost)) return url;
  return `https://${baseHost}`;
}
