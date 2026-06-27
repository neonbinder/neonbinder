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
  /** True if the text matches a known challenge/blocked/invalid signal. */
  challengeDetected?: boolean;
  /** Redacted, <= MAX_SNIPPET_CHARS of visible text / body. */
  snippet?: string;
}

/** Plaintext secrets in scope at the call site, to redact by exact value. */
export interface DiagnosticSecrets {
  email?: string;
  password?: string;
}

const MAX_SNIPPET_CHARS = 1500;
const REDACTED = "[REDACTED]";

/**
 * Signals that the login failed because the marketplace served a challenge /
 * block page rather than authenticating. Matched case-insensitively against
 * the captured visible text. "not a valid email address" is the SportLots
 * tell described in the diagnostics requirements.
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
  /not a valid email address/i,
];

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  // 1. Exact known values typed into the page. Longest first so a password
  //    that contains the email (unlikely but cheap to guard) is handled.
  const exact = [secrets.email, secrets.password]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
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

  const diagnostic: LoginDiagnostic = { challengeDetected };
  if (input.url) diagnostic.url = input.url;
  if (input.title) diagnostic.title = redactSecrets(input.title, secrets);
  if (snippet) diagnostic.snippet = snippet;
  return diagnostic;
}
