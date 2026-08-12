import {
  BaseAdapter,
  AdapterResponse,
  LoginOptions,
  REAUTH_REQUIRED_ERROR,
  isCanaryKey,
} from "./base-adapter";
import { Credentials, SecretsManagerService } from "../services/secrets-manager";
import { buildLoginDiagnostic } from "../services/login-diagnostic";

// SportLots login POST endpoint — recorded as diagnostic.url on failures.
const SL_LOGIN_URL = "https://www.sportlots.com/cust/custbin/signin.tpl";

// Retry budget for transient SportLots failures.
// Backoffs apply BETWEEN attempts: 1→2, 2→3, 3→4, 4→5.
// Total max added sleep ≈ 7.5s; well inside Cloud Run's default timeout.
const MAX_ATTEMPTS = 5;
const BACKOFFS_MS = [500, 1000, 2000, 4000];

// NEO-43: the synthetic canary runs a reduced retry budget.
//
// NOT for rate-limit or anti-abuse reasons — neither SportLots nor BSC
// throttles logins, and there is no such thing as BSC "bot protection". That
// belief has been raised and disproven repeatedly on this project; don't
// reintroduce it. The reason here is monitoring correctness: a canary exists
// to REPORT failures, and retrying five times masks a marketplace that is
// intermittently failing — which is precisely the signal we want to see. Two
// attempts tolerates one dropped connection without hiding a pattern.
const CANARY_MAX_ATTEMPTS = 2;

// Conservative TTL for cached SL session cookies. SL sessions empirically
// last much longer (~24h), but we'd rather invalidate eagerly than serve
// SportLots sessions are effectively permanent — once authenticated, the
// session cookie persists indefinitely until the user explicitly logs
// out or SL purges the session server-side (rare). We set a long cache
// TTL (30 days) and lean on the validate-on-cache-hit branch above to
// catch sessions that turn out to be dead. Previous 4-hour TTL was
// over-cautious and forced unnecessary Puppeteer-free re-logins on
// long-running browser sessions.
const CACHED_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sleepWithJitter(baseMs: number): Promise<void> {
  const jitter = baseMs * (Math.random() * 0.6 - 0.3); // ±30%
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, baseMs + jitter)));
}

export class SportlotsAdapter extends BaseAdapter {
  constructor(page: any) {
    super(page, "Sportlots");
  }

  getHomeUrl(): string {
    return "https://www.sportlots.com";
  }

  /**
   * Login to SportLots.
   *
   * First, if the per-user secret already holds a non-expired cached cookie,
   * cheaply revalidate it against /inven/dealbin/newinven.tpl. On hit we
   * short-circuit and skip the full login flow entirely — this is the fix
   * for SL rate-limiting the shared CI test username when many flows trigger
   * /login/sportlots in quick succession (mirrors the BSC adapter pattern).
   *
   * On miss (no token / expired / failed revalidation) we clear the stale
   * cache and fall through to the existing HTTP login flow, which retries up
   * to MAX_ATTEMPTS on transient failures (429, 5xx, network error, empty
   * cookie body) and bails immediately on permanent ones (4xx non-429,
   * invalid credentials, validation seeing a login page).
   */
  async login(key: string, opts?: LoginOptions): Promise<AdapterResponse> {
    const secretsManager = new SecretsManagerService();
    const canary = opts?.canary === true;
    const transient = opts?.transientCredentials;

    // NEO-141: credentials supplied in the request body mean "sign in fresh
    // with these" — the bootstrap and explicit-re-auth path. Skip the cache
    // and the stored secret entirely (the secret may not exist yet), and run
    // the normal retry loop. The password is used here and discarded; the
    // write-back in attemptLogin persists only {username, token, expiresAt}.
    if (transient) {
      console.log(`[SportLots Adapter] request supplied credentials; fresh sign-in`);
      return this.retryLogin(key, canary, transient);
    }

    // Cache hit path: try the stored cookie before hitting the login form.
    //
    // NEO-43: the canary skips this. CACHED_TOKEN_TTL_MS is 30 DAYS, so a
    // canary that honoured the cache would POST the real SportLots signin
    // form roughly once a month and spend every other run validating a stale
    // cookie — precisely blind to the multi-minute SL login hang that
    // prompted this ticket.
    // Left undefined when the secret could not be READ at all — see the guard
    // below, which depends on telling "read it, no password" apart from
    // "couldn't read it".
    let stored: Credentials | undefined;
    try {
      const credentials = await secretsManager.getCredentials(key);
      stored = credentials;
      if (
        !canary &&
        credentials.token &&
        credentials.expiresAt &&
        credentials.expiresAt > Date.now()
      ) {
        console.log(
          `[SportLots Adapter] cached token present, validating against ${this.siteName}...`,
        );
        const valid = await this.validateCachedCookie(credentials.token);
        if (valid) {
          console.log(`[SportLots Adapter] cached token valid; reusing.`);
          return {
            success: true,
            message: `Used cached token for ${this.siteName}`,
            expiresAt: credentials.expiresAt,
          };
        }
        // Stale or revoked cookie. Fall through to the fresh-login loop.
        //
        // NEO-115: we deliberately do NOT write a token-cleared version here.
        // That write burned a whole Secret Manager version (billed forever)
        // purely to blank a field that attemptLogin's write-back overwrites
        // moments later. The dead cookie just stays in the secret until the
        // fresh login replaces it; it can never cause a false success,
        // because the cache-hit branch above only returns success when
        // validateCachedCookie actually authenticates it.
        console.log(
          `[SportLots Adapter] cached token invalid, re-authenticating...`,
        );
      }
    } catch (error) {
      // Cache lookup failure should never block a fresh login. Log and fall
      // through. The fresh-login path will hit getCredentials again and
      // surface a real error if credentials are genuinely unreadable.
      console.log(
        `[SportLots Adapter] cache lookup failed, proceeding to fresh login: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // NEO-141: we read the secret, the cached cookie is gone or dead, and
    // there is no password — neither in the request body nor in the secret,
    // because user secrets no longer store one. There is nothing left to try.
    //
    // This is a NORMAL end state (SL sessions do eventually lapse), not a
    // fault, so it must be reported as its own thing: reauth_required → 422,
    // never pages, and tells Convex to prompt a sign-in.
    //
    // Note the guard on `stored`: if the secret could not be READ at all we
    // fall through to the retry loop exactly as before, so a transient Secret
    // Manager blip keeps its existing behaviour instead of being reported to
    // the user as an expired session.
    if (stored && !stored.password) {
      console.log(
        `[SportLots Adapter] no valid cached session and no password available — re-auth required`,
      );
      return { success: false, error: REAUTH_REQUIRED_ERROR, reauthRequired: true };
    }

    return this.retryLogin(key, canary, undefined);
  }

  /**
   * The retry loop around attemptLogin.
   *
   * @param credentials when supplied, these transient request-body credentials
   *   drive the sign-in and attemptLogin never reads the stored secret. When
   *   omitted, each attempt reads the secret itself — the canary path, and the
   *   legacy path for user secrets that still carry a password.
   */
  private async retryLogin(
    key: string,
    canary: boolean,
    credentials: { username: string; password: string } | undefined,
  ): Promise<AdapterResponse> {
    // NEO-43: reduced retry budget for the canary — see CANARY_MAX_ATTEMPTS.
    // Retrying hard would hide an intermittently-failing marketplace behind a
    // green canary; a monitoring probe must surface that, not paper over it.
    // Genuine one-off blips are absorbed by the alert policy, which needs
    // repeated failures before it fires.
    const maxAttempts = canary ? CANARY_MAX_ATTEMPTS : MAX_ATTEMPTS;

    let last: AdapterResponse = { success: false, error: "Login did not run" };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        console.log(
          `[SportLots Adapter] retry attempt ${attempt}/${maxAttempts} — previous error: ${last.error}`,
        );
      }
      last = await this.attemptLogin(key, attempt, canary, credentials);
      if (last.success) return last;
      if (!last.retryable || attempt === maxAttempts) return last;
      await sleepWithJitter(BACKOFFS_MS[attempt - 1]);
    }
    return last;
  }

  /**
   * Cheap GET against a known authenticated page using the stored cookie.
   *
   * SportLots responds 200 even to expired session cookies — the body just
   * contains the public login form instead of the dealer dashboard. So we
   * can't trust status alone; we apply the same login-page detection used
   * by attemptLogin() right after a fresh login.
   *
   * Any thrown network error (DNS, timeout, ECONNRESET) is treated as
   * "couldn't validate" rather than "definitely invalid", so the caller
   * clears the cache and a fresh login retry-loops as normal.
   *
   * @returns true if the cookie still authenticates; false otherwise.
   */
  private async validateCachedCookie(cookieString: string): Promise<boolean> {
    try {
      const response = await fetch(
        "https://www.sportlots.com/inven/dealbin/newinven.tpl",
        {
          method: "GET",
          headers: { Cookie: cookieString },
          redirect: "manual",
        },
      );
      // 3xx redirect or non-200 → don't trust this cookie.
      if (response.status !== 200) {
        console.log(
          `[SportLots Adapter] cached-cookie validation status=${response.status}; treating as invalid`,
        );
        return false;
      }
      const body = await response.text();
      // Same heuristic as the post-fresh-login validation: SL silently
      // rewrites the body to the login form when the session is gone.
      if (body.includes("login.tpl") || body.includes("signin.tpl")) {
        console.log(
          `[SportLots Adapter] cached-cookie validation body contained login/signin reference; treating as invalid`,
        );
        return false;
      }
      return true;
    } catch (error) {
      console.log(
        `[SportLots Adapter] cached-cookie validation threw: ${
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error)
        }`,
      );
      return false;
    }
  }

  /**
   * Single login attempt. Sets `retryable: true` on error branches we want the
   * outer loop to retry (transient upstream issues, empty body); leaves it
   * undefined on permanent errors so the caller bails immediately.
   */
  private async attemptLogin(
    key: string,
    attempt: number,
    canary = false,
    supplied?: { username: string; password: string },
  ): Promise<AdapterResponse> {
    const t0 = Date.now();
    const log = (msg: string) =>
      console.log(`[SportLots Adapter] ${msg} (t+${Date.now() - t0}ms, attempt ${attempt}/${MAX_ATTEMPTS})`);
    try {
      log("login start");
      const secretsManager = new SecretsManagerService();
      // Transient request-body credentials win outright and short-circuit the
      // secret read: on the bootstrap path the secret may not exist yet.
      const credentials = supplied ?? (await secretsManager.getCredentials(key));
      // NEO-141: a STORED secret with a username and no password is not a
      // malformed credential — it is the normal steady state of every user
      // secret whose SL session has lapsed, and it means exactly one thing:
      // the user has to sign in again.
      //
      // login() normally catches this before we get here, but its guard is
      // skipped when the first getCredentials threw transiently (`stored`
      // stays undefined). Without this branch that path lands on the generic
      // "Invalid credentials format" below → 422 invalid_credentials → the user
      // is told to check credentials they were never asked for, and
      // `needsReauth` is never set, so the amber "sign in again" card — the
      // entire UX point of NEO-141 — never renders.
      if (!supplied && credentials.username && !credentials.password) {
        log("stored secret has a username but no password — re-auth required");
        return { success: false, error: REAUTH_REQUIRED_ERROR, reauthRequired: true };
      }
      if (!credentials.username || !credentials.password) {
        log("credentials missing username/password");
        return {
          success: false,
          error: "Invalid credentials format",
          // NEO-98: stored secret is incomplete, so SportLots never gets
          // asked. Caller-data problem, not a service fault — 422, no page.
          credentialRejected: true,
        };
      }

      const loginUrl = SL_LOGIN_URL;
      const body = new URLSearchParams({
        email_val: credentials.username,
        psswd: credentials.password,
      });

      log("POST /cust/custbin/signin.tpl");
      const response = await fetch(loginUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        redirect: "manual",
      });
      log(`login response status=${response.status}`);

      // Check for upstream failures before parsing cookies
      if (response.status === 429) {
        log("login rejected: 429 rate limit");
        return {
          success: false,
          error: "SportLots rate limit exceeded. Please try again later.",
          retryable: true,
        };
      }
      if (response.status >= 500) {
        log(`login rejected: upstream ${response.status}`);
        return {
          success: false,
          error: `SportLots is unavailable (HTTP ${response.status}). Please try again later.`,
          retryable: true,
        };
      }
      if (response.status >= 400) {
        log(`login rejected: upstream ${response.status}`);
        return {
          success: false,
          error: `SportLots returned an error (HTTP ${response.status}).`,
        };
      }

      const responseBody = await response.text();
      log(`login body received bytes=${responseBody.length}`);

      // SportLots sets cookies via JavaScript in the response body
      const cookieRegex = /document\.cookie\s*=\s*"([^"]+)"/g;
      const cookies: string[] = [];
      let cookieMatch;

      while ((cookieMatch = cookieRegex.exec(responseBody)) !== null) {
        const nameValue = cookieMatch[1].split(";")[0].trim();
        if (nameValue) {
          cookies.push(nameValue);
        }
      }
      log(`parsed ${cookies.length} cookie(s) from body`);

      if (cookies.length === 0) {
        // Most often a blank/slow body from SL; retry once. This is also the
        // "Not a valid Email Address" case the diagnostics work targets —
        // build a sanitized diagnostic from the response body (redacted of the
        // typed email/password).
        //
        // SECURITY (NEO-141): this used to log the first 200 raw bytes of the
        // body. It must not. SportLots sets its session cookies via inline
        // `document.cookie="…"` IN THE RESPONSE BODY — that is the very thing
        // the regex above parses — so a raw preview can put a live SL session
        // cookie into Cloud Logging, where it is readable for ~30 days by
        // anyone with logging.viewer and is an account takeover for that
        // seller with no revocation path we control. Ordinary login failures
        // reach this branch, so no attacker action is required.
        //
        // Only BOOLEANS derived from the body are logged. The redacted snippet
        // still travels to PostHog on the response, which is the intended
        // channel for page-derived text (see the diagnostic handling in
        // src/index.ts, which logs challenge_detected and nothing else).
        const diagnostic = buildLoginDiagnostic(
          { url: loginUrl, rawText: responseBody },
          { email: credentials.username, password: credentials.password },
        );
        log(
          `no-cookies diagnostic: challengeDetected=${diagnostic.challengeDetected} ` +
            `credentialRejectionDetected=${diagnostic.credentialRejectionDetected}`,
        );
        // NEO-98/NEO-100: this branch is two different events wearing one
        // error string, and it matters because it IS the real seller-typo path
        // for SportLots — SL answers a refused login with HTTP 200, never a
        // status code.
        //
        // It signals the reason in a `?message=` JS redirect, so we match that
        // rather than guessing. An unrecognised message is NOT a rejection: it
        // stays a 502 and pages, because a changed SportLots login flow must
        // not be able to masquerade as a wave of seller typos.
        //
        // challengeDetected vetoes: if SL served a block page, that is us being
        // bot-blocked and it must page whatever else the page says.
        const credentialRejected =
          diagnostic.credentialRejectionDetected === true &&
          diagnostic.challengeDetected !== true;
        return {
          success: false,
          error: "No session cookies received. Check credentials.",
          // NEO-100: only retry when we DON'T know it was a rejection. The
          // retry exists for the blank/slow body case; replaying a login
          // SportLots has already explicitly refused just spends four more
          // round trips (and four more failed attempts against their account)
          // to arrive at the same answer.
          retryable: !credentialRejected,
          diagnostic,
          credentialRejected,
        };
      }

      const cookieString = cookies.join("; ");

      // Validate cookies actually authenticate by fetching a protected page
      log("GET /inven/dealbin/newinven.tpl (validation)");
      const validateResponse = await fetch("https://www.sportlots.com/inven/dealbin/newinven.tpl", {
        method: "GET",
        headers: { Cookie: cookieString },
        redirect: "manual",
      });
      const validateBody = await validateResponse.text();
      log(
        `validation response status=${validateResponse.status} bytes=${validateBody.length}`,
      );

      if (validateBody.includes("login.tpl") || validateBody.includes("signin.tpl")) {
        // SECURITY (NEO-141): NO raw preview of this body, ever. The comment
        // immediately below states the property that makes one unsafe — SL's
        // response to a cookie it has just rejected can echo the session id
        // straight back — so a `console.log` of the first 200 bytes would put
        // a live session cookie into Cloud Logging while the sanitized copy
        // that leaves over HTTPS is redacted. Booleans only here; the redacted
        // snippet reaches PostHog on the response instead.
        //
        // NEO-141: the freshly-minted cookie string is passed for exact-value
        // redaction. SL's response to a cookie it has just rejected can echo
        // the session id straight back, and an SL cookie has no structural
        // tell that redactSecrets' generic token patterns are guaranteed to
        // catch — this diagnostic leaves the service in the HTTP response.
        const diagnostic = buildLoginDiagnostic(
          { url: loginUrl, rawText: validateBody },
          {
            email: credentials.username,
            password: credentials.password,
            token: cookieString,
          },
        );
        log(`validation-failed diagnostic: challengeDetected=${diagnostic.challengeDetected}`);
        // NEO-98: SL handed us cookies and then bounced them straight back to
        // the login form. It processed the sign-in and declined to grant a
        // session — a rejection, not an outage. (Unless we were challenged,
        // which is us being blocked.)
        return {
          success: false,
          error: "SportLots login validation failed. Cookies did not authenticate.",
          diagnostic,
          credentialRejected: diagnostic.challengeDetected !== true,
        };
      }

      // Store the cookie + TTL so login() can short-circuit on the next
      // call. Without expiresAt, the cache-hit branch above can never fire.
      //
      // NEO-43: the canary must NOT write back — every write adds a new,
      // permanently-enabled Secret Manager version, and skipping it keeps the
      // canary key permanently cache-free so each run is guaranteed to
      // exercise the real signin form. See LoginOptions in ../observability.
      //
      // The guard is on the KEY as well as the flag, and the KEY half is the
      // load-bearing one — see isCanaryKey. A canary-keyed request that simply
      // omitted `canary: true` would otherwise write back a password-less
      // payload, and keep-1 pruning would destroy the canary's password for
      // good. Flag-only protection made that a caller's responsibility;
      // key-based protection makes it structurally true.
      const expiresAt = Date.now() + CACHED_TOKEN_TTL_MS;
      if (canary || isCanaryKey(key)) {
        log("login success; canary key/run — skipping token write-back");
      } else {
        // NEO-141: `password` is deliberately NOT in this list. It used to be,
        // which meant the seller's SportLots password was re-persisted on
        // every single successful login and could never leave the secret. The
        // session cookie in `token` is now the whole of the durable session
        // state; the password was only ever needed to mint it.
        await secretsManager.updateCredentials(key, {
          username: credentials.username,
          token: cookieString,
          expiresAt,
        });
        log("login success; token stored");
      }

      return {
        success: true,
        message: `Successfully logged into ${this.siteName}`,
        expiresAt,
      };
    } catch (error) {
      log(`login threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      return {
        success: false,
        error: `Failed to login to ${this.siteName}: ${error}`,
        retryable: true,
      };
    }
  }
}
