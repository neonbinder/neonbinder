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
 * ## Nothing reaches Google until the token could plausibly pass
 *
 * tokeninfo is only asked about a bearer that is shaped like a JWT (three
 * base64url segments whose middle one decodes to a JSON object) AND whose
 * UNVERIFIED payload already names our audience and an allowlisted email.
 * Anything else is refused here with no network call, so an unauthenticated
 * caller sending `Bearer <garbage>` cannot make this deployment spend a
 * round trip (and a log line) per request on Google (the NEO-172 trap).
 *
 * The unverified decode can only REFUSE. It never grants: everything that
 * passes it still goes to tokeninfo, and the post-verify checks below run
 * on Google's answer alone, exactly as if the pre-check did not exist.
 *
 * The token is sent as a POST form body (`id_token=…`), never in the query
 * string, so it does not sit in a URL that a proxy or client log might keep.
 *
 * ## Result shape
 *
 * `{ ok: true, email }` or `{ ok: false, status, reason }`. `status` is the
 * HTTP status the caller should answer with — 401 for "no usable token"
 * (missing, not a JWT, rejected by Google, wrong issuer or audience), 403 for
 * "an identity we do not accept" (unverified, not allowlisted, or no
 * allowlist configured at all: fail closed), 503 when Google could not be
 * asked or asked us to back off (5xx, 429, timeout). `reason` is a closed set meant for a server-side log line; it never
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
  | "malformed_token"
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

/** Three non-empty base64url segments: header, payload, signature. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/;

/**
 * Claims read from the UNVERIFIED payload. Used only to refuse early; a
 * value here never contributes to an `ok: true` verdict.
 */
interface UnverifiedClaims {
  aud?: unknown;
  email?: unknown;
}

/** base64url → UTF-8 text, or null if it is not valid base64url / UTF-8. */
function decodeBase64Url(segment: string): string | null {
  // A base64 length of 1 mod 4 can never be produced by an encoder.
  if (segment.length % 4 === 1) return null;
  const base64 =
    segment.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (segment.length % 4)) % 4);
  try {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Decode a JWT's payload WITHOUT verifying it. Returns null for anything
 * that is not a three-segment base64url token whose payload is a JSON object.
 */
function decodeUnverifiedPayload(token: string): UnverifiedClaims | null {
  const match = JWT_SHAPE.exec(token);
  if (!match) return null;
  const text = decodeBase64Url(match[1]);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as UnverifiedClaims;
  } catch {
    return null;
  }
}

/** True when the claimed audience, as a string, normalises to `expected`. */
function audienceMatches(aud: unknown, expected: string): boolean {
  return typeof aud === "string" && normaliseAudience(aud) === expected;
}

/** The claimed email, lowercased, if it is a string in the allowlist. */
function allowlistedEmail(
  email: unknown,
  allowlist: ReadonlySet<string>,
): string | null {
  if (typeof email !== "string") return null;
  const normalised = email.trim().toLowerCase();
  return allowlist.has(normalised) ? normalised : null;
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
  const unverified = decodeUnverifiedPayload(bearer.token);
  if (unverified === null) return fail(401, "malformed_token");

  // Configuration before the network: an unconfigured deployment refuses
  // everyone without asking Google anything.
  const expectedAudience = audience ? normaliseAudience(audience) : "";
  if (!expectedAudience) return fail(401, "audience_unset");
  const allowlist = parseAllowlist(allowedEmails);
  if (allowlist.size === 0) return fail(403, "allowlist_unset");

  // Refuse-only pre-check on the UNVERIFIED payload: a token that does not
  // even claim to be for us, from an allowlisted caller, is not worth a call
  // to Google. Passing this proves nothing; the checks after tokeninfo run
  // on Google's answer alone.
  if (!audienceMatches(unverified.aud, expectedAudience)) {
    return fail(401, "audience_mismatch");
  }
  if (allowlistedEmail(unverified.email, allowlist) === null) {
    return fail(403, "email_not_allowed");
  }

  const doFetch = fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKENINFO_TIMEOUT_MS);
  let response: Response;
  try {
    // POST with a form body keeps the token out of every URL.
    response = await doFetch(GOOGLE_TOKENINFO_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: bearer.token }).toString(),
      signal: controller.signal,
    });
  } catch {
    return fail(503, "tokeninfo_unreachable");
  } finally {
    clearTimeout(timer);
  }

  // tokeninfo answers 400 for a forged, expired or garbled token. A 5xx or a
  // 429 is Google's trouble (or Google telling us to back off), not the
  // caller's, and says nothing about the token.
  if (response.status >= 500 || response.status === 429) {
    return fail(503, "tokeninfo_unreachable");
  }
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
  if (!audienceMatches(claims.aud, expectedAudience)) {
    return fail(401, "audience_mismatch");
  }
  if (claims.email_verified !== "true") return fail(403, "email_unverified");
  const email = allowlistedEmail(claims.email, allowlist);
  if (email === null) return fail(403, "email_not_allowed");

  return { ok: true, email };
}
