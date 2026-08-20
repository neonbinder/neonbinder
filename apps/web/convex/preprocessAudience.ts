// Pure helper (no node-only deps) so it can be unit-tested in the edge-runtime
// vitest project that covers `convex/**`. Imported by adapters/preprocess.ts.
//
// The exact twin of convex/browserAudience.ts, for the preprocess services
// (NEO-175). Cloud Run tagged-revision URLs (the per-PR previews) look like
//   https://pr-<N>---neonbinder-preprocess-fast-<hash>-uc.a.run.app
//   https://pr-<N>---neonbinder-preprocess-<hash>-uc.a.run.app
// Requests must be SENT to that tagged host to reach the PR revision, but Cloud
// Run IAM validates the OIDC token's audience against the *base* service URL,
// not the tagged host. So when the target is a tagged host of one of OUR
// preprocess services, mint the token for the base origin — everything after the
// first `---` tag separator. Every other URL (plain service URL, loopback dev,
// any unrecognized host) is returned verbatim so it flows through the normal
// auth path and fails closed.
//
// Without this, adapters/preprocess.ts passed the request URL straight to
// buildAuthHeaders as the audience — which works for a plain service URL but
// 403s on a tagged preview host once Cloud Run IAM is enforced (the token's
// audience would be the tagged host, which IAM does not accept).

// The base host of either preprocess Cloud Run service in us-central1 (`uc`),
// for either env and either role:
//   heavy: neonbinder-preprocess-<hash>-uc.a.run.app
//   fast:  neonbinder-preprocess-fast-<hash>-uc.a.run.app
// Binding to this pattern (rather than stripping any `---`-containing run.app
// host) means a crafted/unexpected host can never coerce us into minting an
// OIDC token for an attacker-named audience — the same defense-in-depth
// BROWSER_SERVICE_BASE_HOST gives the browser service.
const PREPROCESS_SERVICE_BASE_HOST =
  /^neonbinder-preprocess(-fast)?-[a-z0-9]+-uc\.a\.run\.app$/;

export function preprocessAudienceFor(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return url;
  }
  const sep = host.indexOf("---");
  if (sep === -1) return url;
  const baseHost = host.slice(sep + 3);
  if (!PREPROCESS_SERVICE_BASE_HOST.test(baseHost)) return url;
  return `https://${baseHost}`;
}
