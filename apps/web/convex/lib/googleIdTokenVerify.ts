/**
 * NEO-355 — verify a Google-signed OIDC id token presented to a Convex HTTP
 * action, and decide whether its caller is one of the service accounts we
 * expect.
 *
 * ## Why identity, not a shared secret
 *
 * NEO-20 removed the last shared key between Convex and the browser service
 * (`INTERNAL_API_KEY`), and Cloud Run IAM became the whole auth boundary in
 * the Convex → Cloud Run direction. The reverse direction keeps that shape:
 * the caller proves WHO it is with an id token Google minted for its own
 * runtime service account, and Convex checks the identity against an
 * allowlist. There is nothing to rotate, nothing to copy between dev, preview
 * and prod, and nothing that leaks usefully from a log.
 *
 * ## Why tokeninfo rather than local JWT verification
 *
 * `oauth2.googleapis.com/tokeninfo` checks the signature against Google's
 * current keys and rejects an expired token (it answers 400), so this module
 * carries no JWKS cache, no clock-skew handling and no crypto dependency. The
 * endpoint is called rarely (a canary a few times a day), so the extra round
 * trip costs nothing that matters. What tokeninfo does NOT know is who we
 * expect, so the claims below are checked here:
 *
 *   - `iss` is Google (`accounts.google.com`, with or without the scheme);
 *   - `aud` is THIS deployment's site URL, so a token minted for some other
 *     service cannot be replayed against us;
 *   - `email_verified` is the string `"true"` (tokeninfo returns strings);
 *   - `email` is in the allowlist.
 *
 * ## Result shape
 *
 * `{ ok: true, email }` or `{ ok: false, status, reason }`. `status` is the
 * HTTP status the caller should answer with — 401 for "no usable token"
 * (missing, rejected by Google, wrong issuer or audience), 403 for "a real
 * Google identity we do not accept" (unverified, not allowlisted, or no
 * allowlist configured at all: fail closed), 503 when Google could not be
 * asked. `reason` is a closed set meant for a server-side log line; it never
 * contains the token, a claim value or the tokeninfo body.
 *
 * Pure apart from the injected `fetchImpl`: no `process.env`, no Convex
 * imports, so it runs in the default Convex runtime and in Vitest unchanged.
 */

/** Google's token introspection endpoint. Signature + expiry are its job. */
export const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";

/** Issuers Google uses on id tokens; both spellings appear in the wild. */
const GOOGLE_ISSUERS: ReadonlySet<string> = new Set([
  "accounts.google.com",
  "https://accounts.google.com",
]);

/**
 * Upper bound on the tokeninfo round trip. The browser service gives the whole
 * pause lookup (mint + fetch) five seconds and proceeds with a real sign-in
 * when it runs out, so a slower answer than this is useless to it anyway.
 */
const TOKENINFO_TIMEOUT_MS = 3_000;

/** A Google id token is ~1 KB; anything far past that is not one. */
const MAX_TOKEN_LENGTH = 8_192;

export type GoogleIdTokenFailureReason =
  | "missing_token"
  | "malformed_authorization"
  | "audience_unset"
  | "allowlist_unset"
  | "tokeninfo_unreachable"
  | "token_rejected"
  | "bad_tokeninfo_body"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "email_unverified"
  | "email_not_allowed";

export type GoogleIdTokenVerification =
  | { ok: true; email: string }
  | { ok: false; status: 401 | 403 | 503; reason: GoogleIdTokenFailureReason };

export interface VerifyGoogleIdTokenOptions {
  /** Expected `aud` — this deployment's site URL. Unset fails closed (401). */
  audience: string | undefined;
  /**
   * Accepted caller emails: either the raw comma-separated env value or an
   * already-split list. Unset or empty fails closed (403).
   */
  allowedEmails: string | readonly string[] | undefined;
  /** Injected for tests; defaults to the global `fetch` at call time. */
  fetchImpl?: typeof fetch;
}

/**
 * The subset of a tokeninfo response this module reads. Every field is
 * `unknown` until checked: the body is external input.
 */
interface TokenInfoClaims {
  iss?: unknown;
  aud?: unknown;
  email?: unknown;
  email_verified?: unknown;
}

function fail(
  status: 401 | 403 | 503,
  reason: GoogleIdTokenFailureReason,
): GoogleIdTokenVerification {
  return { ok: false, status, reason };
}

/** Trailing slashes are not identity: `https://x.site/` is `https://x.site`. */
function normaliseAudience(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function parseAllowlist(
  allowedEmails: string | readonly string[] | undefined,
): ReadonlySet<string> {
  const entries =
    typeof allowedEmails === "string"
      ? allowedEmails.split(",")
      : (allowedEmails ?? []);
  const out = new Set<string>();
  for (const entry of entries) {
    const email = entry.trim().toLowerCase();
    if (email) out.add(email);
  }
  return out;
}

/** `Bearer <token>` → the token, or a failure reason. Never echoes the input. */
function extractBearer(
  authorization: string | null | undefined,
): { token: string } | { reason: GoogleIdTokenFailureReason } {
  if (authorization == null || authorization.trim() === "") {
    return { reason: "missing_token" };
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization.trim());
  if (!match || match[1].length > MAX_TOKEN_LENGTH) {
    return { reason: "malformed_authorization" };
  }
  return { token: match[1] };
}

/**
 * Verify the `Authorization` header of an inbound request. See the file
 * comment for the checks, their order and the meaning of each status.
 */
export async function verifyGoogleIdToken(
  authorization: string | null | undefined,
  { audience, allowedEmails, fetchImpl }: VerifyGoogleIdTokenOptions,
): Promise<GoogleIdTokenVerification> {
  const bearer = extractBearer(authorization);
  if ("reason" in bearer) return fail(401, bearer.reason);

  // Configuration before the network: an unconfigured deployment refuses
  // everyone without asking Google anything.
  const expectedAudience = audience ? normaliseAudience(audience) : "";
  if (!expectedAudience) return fail(401, "audience_unset");
  const allowlist = parseAllowlist(allowedEmails);
  if (allowlist.size === 0) return fail(403, "allowlist_unset");

  const doFetch = fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKENINFO_TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(
      `${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(bearer.token)}`,
      { method: "GET", signal: controller.signal },
    );
  } catch {
    return fail(503, "tokeninfo_unreachable");
  } finally {
    clearTimeout(timer);
  }

  // tokeninfo answers 400 for a forged, expired or garbled token. A 5xx is
  // Google's trouble, not the caller's, and says nothing about the token.
  if (response.status >= 500) return fail(503, "tokeninfo_unreachable");
  if (response.status !== 200) return fail(401, "token_rejected");

  let claims: TokenInfoClaims;
  try {
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fail(401, "bad_tokeninfo_body");
    }
    claims = parsed as TokenInfoClaims;
  } catch {
    return fail(401, "bad_tokeninfo_body");
  }

  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.has(claims.iss)) {
    return fail(401, "issuer_mismatch");
  }
  if (
    typeof claims.aud !== "string" ||
    normaliseAudience(claims.aud) !== expectedAudience
  ) {
    return fail(401, "audience_mismatch");
  }
  if (claims.email_verified !== "true") return fail(403, "email_unverified");
  if (typeof claims.email !== "string") return fail(403, "email_not_allowed");
  const email = claims.email.trim().toLowerCase();
  if (!allowlist.has(email)) return fail(403, "email_not_allowed");

  return { ok: true, email };
}
