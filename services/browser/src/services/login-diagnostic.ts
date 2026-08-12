/**
 * Login-failure diagnostics for marketplace adapters.
 *
 * SECURITY-CRITICAL. The objects produced here LEAVE the browser service in
 * the HTTP login response and are forwarded by the Convex layer into a
 * PostHog `credential_test_failed` event. The source material is a LOGIN
 * page, which can contain the typed account email/password, session tokens,
 * `Bearer` strings, and `Set-Cookie`/raw cookies. NONE of that may ever
 * appear in the emitted diagnostic.
 *
 * Defense in depth:
 *  1. Caller passes the in-scope `secrets` (email/password) so we can redact
 *     the exact values that were typed into the page.
 *  2. We additionally strip token/cookie-shaped substrings unconditionally,
 *     so an unexpected token format still can't escape.
 *  3. We truncate to MAX_SNIPPET_CHARS of visible text only — callers must
 *     pass `document.body.innerText`-style text, not raw HTML, to avoid
 *     inline <script> tokens.
 */

export interface LoginDiagnostic {
  /** page.url() for BSC; the SL login POST URL. */
  url?: string;
  /** page.title() for BSC; omitted/empty for SL. */
  title?: string;
  /** True if the text matches a known challenge/blocked signal. */
  challengeDetected?: boolean;
  /**
   * NEO-98: true if the text carries a marketplace's own "we refused these
   * credentials" tell (e.g. SportLots' "Not a valid Email Address").
   *
   * Deliberately SEPARATE from challengeDetected. Being bot-blocked and
   * having a seller mistype a password are opposite findings — one pages us,
   * the other must never page — and collapsing them into one boolean is what
   * this field exists to prevent.
   */
  credentialRejectionDetected?: boolean;
  /** Redacted, <= MAX_SNIPPET_CHARS of visible text / body. */
  snippet?: string;
}

/**
 * Plaintext secrets in scope at the call site, to redact by exact value.
 *
 * NEO-141: this list must grow whenever `Credentials` grows. Exact-value
 * redaction is the only defence that does not depend on a secret LOOKING like
 * a secret — the structural patterns in redactSecrets catch Bearer/JWT/cookie
 * shapes, but a marketplace is free to echo an opaque session string back in a
 * page body in a shape none of them match. If a value is in scope at the call
 * site, pass it here.
 */
export interface DiagnosticSecrets {
  email?: string;
  password?: string;
  /** Cached session credential: BSC access token or SL session-cookie string. */
  token?: string;
  /** BSC refresh token (rotating). */
  refreshToken?: string;
}

const MAX_SNIPPET_CHARS = 1500;
const REDACTED = "[REDACTED]";

/**
 * Signals that the login failed because the marketplace served a challenge /
 * block page rather than authenticating. Matched case-insensitively against
 * the captured visible text.
 *
 * NEO-98: "not a valid email address" USED to live in this list. It was moved
 * to CREDENTIAL_REJECTION_PATTERNS below, because the meaning of this flag
 * changed underneath it. When the list was written (NEO-18) it answered the
 * broad question "why did this login fail". NEO-43 then repurposed the same
 * boolean as an ALERTING discriminator — per observability.ts it is now "the
 * only signal that separates 'the marketplace is blocking us' (page us) from
 * 'the seller mistyped their password' (do nothing)".
 *
 * Under that meaning, the SportLots typo tell sitting in this list inverted
 * the exact distinction the flag exists to make: an ordinary mistyped email
 * reported challengeDetected=true, i.e. "we are being blocked, page someone".
 *
 * Keep this list to genuine block/bot signals only.
 */
const CHALLENGE_PATTERNS: RegExp[] = [
  /captcha/i,
  /recaptcha/i,
  /hcaptcha/i,
  /cloudflare/i,
  /attention required/i,
  /are you (a )?human/i,
  /verify you/i,
  /unusual activity/i,
  /temporarily blocked/i,
  /too many (attempts|requests)/i,
  /rate limit/i,
];

/**
 * NEO-98/NEO-100: signals that the marketplace itself evaluated the
 * credentials and refused them — the seller's problem, never ours.
 *
 * SportLots never uses a status code for this. It answers a refused login
 * with HTTP 200 and a ~115-byte JS-redirect stub that carries the reason in a
 * query param, captured live against the real endpoint on 2026-07-27:
 *
 *   <html><head> </head> <body onload='window.location =
 *     "\?message=Not a valid Email Address";'> </body> </html>
 *
 * Observed messages:
 *   "Not a valid Email Address"       — malformed email
 *   "Invalid email address supplied"  — well-formed but unknown account, and
 *                                       also an empty/incorrect password
 *
 * SportLots deliberately returns the same message for "no such account" and
 * "wrong password" (good practice on their part — it prevents account
 * enumeration), so those do not need separate patterns.
 *
 * The remaining entries are defensive: variants SportLots or a future adapter
 * plausibly emits. An unrecognised message is NOT treated as a rejection —
 * see detectCredentialRejection.
 */
const CREDENTIAL_REJECTION_PATTERNS: RegExp[] = [
  /not a valid email address/i,
  /invalid email address supplied/i,
  /invalid (email|username|password|login|credentials)/i,
  /incorrect (email|username|password)/i,
  /no such (user|account)/i,
  /account (is )?(locked|disabled|suspended)/i,
];

/**
 * NEO-100: SportLots' failure envelope — `?message=<reason>` inside the
 * onload redirect above. Bounded to stop at the closing quote/semicolon so a
 * larger page can't drag unrelated text into the match.
 */
const REDIRECT_MESSAGE_RE = /[?&]message=([^"'&;]+)/i;

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Shortest bare cookie value worth redacting on its own.
 *
 * Bare values are redacted without their `name=` prefix, so a short one is
 * indistinguishable from ordinary page text — blanking every "1" or "true"
 * would shred the snippet while protecting nothing. Anything session-shaped is
 * far longer than this.
 */
const MIN_BARE_VALUE_CHARS = 8;

/**
 * Split a cookie string into the pieces that must be redacted individually.
 *
 * A SportLots "token" is `name=value; name=value`. Returns each `name=value`
 * pair plus each sufficiently distinctive bare `value`, so a page echoing only
 * the session id — with no cookie name attached — is still caught. Returns []
 * for anything that is not cookie-shaped (a BSC refresh token, an email).
 */
function cookieParts(value: string): string[] {
  if (!value.includes("=")) return [];
  const parts: string[] = [];
  for (const pair of value.split(";")) {
    const trimmed = pair.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    parts.push(trimmed);
    const bare = trimmed.slice(eq + 1);
    if (bare.length >= MIN_BARE_VALUE_CHARS) parts.push(bare);
  }
  return parts;
}

/**
 * Strip credential- and token-shaped material from a string. This runs in
 * addition to exact-value redaction so that even an unexpected secret format
 * (a token we never had in scope, an inline cookie) cannot leak.
 *
 * The order matters: redact the known plaintext values first (so e.g. an
 * email that also matches a generic pattern is caught), then the structural
 * token/cookie patterns.
 */
function redactSecrets(input: string, secrets: DiagnosticSecrets): string {
  let out = input;

  // 1. Exact known values in scope at the call site. Longest first so a
  //    password that contains the email (unlikely but cheap to guard) is
  //    handled — and so a cookie STRING is redacted before any single
  //    name=value pair inside it is matched separately.
  //
  //    NEO-141: token/refreshToken joined the list. A dead SportLots cookie
  //    is echoed straight back by the page we fetch to validate it, and a
  //    rotating BSC refresh token has no structural tell at all.
  //
  //    NEO-141: a cookie "token" is a JOINED string (`name=value; name=value`).
  //    This pass only matches that whole string, and pattern 5 below only
  //    matches a `name=value` shape — so a BARE value echoed on its own escapes
  //    both, and rides into `diagnostic.snippet` which leaves the service.
  //    SportLots' rejection page can echo exactly that. `cookieParts` therefore
  //    decomposes the cookie so each pair and each bare value is redacted in its
  //    own right.
  const known = [secrets.email, secrets.password, secrets.token, secrets.refreshToken]
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const exact = Array.from(new Set([...known, ...known.flatMap(cookieParts)]))
    .sort((a, b) => b.length - a.length);
  for (const value of exact) {
    out = out.replace(new RegExp(escapeRegExp(value), "gi"), REDACTED);
  }

  // 2. Bearer tokens: "Bearer <token>".
  out = out.replace(/Bearer\s+\S+/gi, `Bearer ${REDACTED}`);

  // 3. Set-Cookie / Cookie headers, including the value.
  out = out.replace(/Set-Cookie\s*:\s*[^\r\n]+/gi, `Set-Cookie: ${REDACTED}`);
  out = out.replace(/(^|[^a-zA-Z0-9-])Cookie\s*:\s*[^\r\n]+/gi, `$1Cookie: ${REDACTED}`);

  // 4. JWT-shaped tokens (three base64url segments joined by dots).
  out = out.replace(
    /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    REDACTED,
  );

  // 5. Cookie name=value pairs that look like a session/token cookie.
  out = out.replace(
    /\b(?:session|sess|token|auth|jwt|sid|sl_session|csrf|xsrf)[a-z0-9_-]*\s*=\s*[^\s;"']+/gi,
    REDACTED,
  );

  return out;
}

/** Collapse whitespace and clamp to MAX_SNIPPET_CHARS. */
function truncate(input: string): string {
  const collapsed = input.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_SNIPPET_CHARS
    ? collapsed.slice(0, MAX_SNIPPET_CHARS)
    : collapsed;
}

/**
 * Decide challengeDetected by scanning the *pre-redaction* visible text. We
 * scan the raw text (not the redacted snippet) so redaction can never mask a
 * challenge signal — none of the challenge patterns overlap with secret
 * values, so this is safe.
 */
function detectChallenge(rawText: string, extra?: string): boolean {
  const haystack = `${rawText}\n${extra ?? ""}`;
  return CHALLENGE_PATTERNS.some((re) => re.test(haystack));
}

/**
 * NEO-98/NEO-100: decide credentialRejectionDetected. Scans pre-redaction text
 * for the same reason detectChallenge does — none of these patterns overlap
 * with secret values, and redaction must not be able to mask the signal.
 *
 * When the `?message=` envelope is present, match ONLY the extracted message.
 * That envelope is the marketplace's own authoritative statement of why it
 * refused, so narrowing to it stops incidental page boilerplate (a maintenance
 * notice that happens to contain the word "password") from reading as a
 * rejection.
 *
 * An envelope carrying an UNRECOGNISED message returns false, i.e. 502, i.e.
 * it pages. That is deliberate and is the safe direction: a surprising new
 * SportLots message should get looked at, not silently filed as user error.
 * The opposite default would let a changed login flow masquerade as a wave of
 * seller typos.
 *
 * Only rawText is scanned, never url/title — a URL containing "login" or
 * "invalid" says nothing about whether the password was refused, whereas a
 * challenge genuinely can show up in a page title or a /challenge path.
 *
 * Returns a BOOLEAN only. The extracted message is never stored or logged: a
 * marketplace is free to echo the submitted identifier back inside it.
 */
function detectCredentialRejection(rawText: string): boolean {
  const enveloped = rawText.match(REDIRECT_MESSAGE_RE);
  const haystack = enveloped ? decodeMessage(enveloped[1]) : rawText;
  return CREDENTIAL_REJECTION_PATTERNS.some((re) => re.test(haystack));
}

/** Best-effort percent/plus decoding; falls back to the raw value. */
function decodeMessage(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/**
 * Build a sanitized {@link LoginDiagnostic}.
 *
 * @param input.url        page.url() (BSC) or login POST URL (SL).
 * @param input.title      page.title() (BSC); omit for SL.
 * @param input.rawText    Visible text (document.body.innerText) or response
 *                         body. Used both for challenge detection and (after
 *                         redaction) the snippet.
 * @param secrets          In-scope plaintext credentials to redact by value.
 * @returns A diagnostic whose snippet contains no credentials or tokens.
 */
export function buildLoginDiagnostic(
  input: { url?: string; title?: string; rawText?: string },
  secrets: DiagnosticSecrets,
): LoginDiagnostic {
  const rawText = input.rawText ?? "";
  // Challenge detection also looks at url + title so a challenge that only
  // shows in the page title or a "/challenge" URL still trips the flag.
  const challengeDetected = detectChallenge(
    rawText,
    `${input.url ?? ""}\n${input.title ?? ""}`,
  );

  const snippet = rawText
    ? truncate(redactSecrets(rawText, secrets))
    : undefined;

  const diagnostic: LoginDiagnostic = {
    challengeDetected,
    credentialRejectionDetected: detectCredentialRejection(rawText),
  };
  if (input.url) diagnostic.url = input.url;
  if (input.title) diagnostic.title = redactSecrets(input.title, secrets);
  if (snippet) diagnostic.snippet = snippet;
  return diagnostic;
}
