import { BaseAdapter, AdapterResponse } from "./base-adapter";
import { SecretsManagerService } from "../services/secrets-manager";
import { buildLoginDiagnostic } from "../services/login-diagnostic";

// SportLots login POST endpoint — recorded as diagnostic.url on failures.
const SL_LOGIN_URL = "https://www.sportlots.com/cust/custbin/signin.tpl";

// Retry budget for transient SportLots failures.
// Backoffs apply BETWEEN attempts: 1→2, 2→3, 3→4, 4→5.
// Total max added sleep ≈ 7.5s; well inside Cloud Run's default timeout.
const MAX_ATTEMPTS = 5;
const BACKOFFS_MS = [500, 1000, 2000, 4000];

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
  async login(key: string): Promise<AdapterResponse> {
    const secretsManager = new SecretsManagerService();

    // Cache hit path: try the stored cookie before hitting the login form.
    try {
      const credentials = await secretsManager.getCredentials(key);
      if (
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
        // Stale or revoked cookie. Clear before falling through so the next
        // call doesn't waste another validation round trip on the same dead
        // token. Username/password are preserved.
        console.log(
          `[SportLots Adapter] cached token invalid, clearing and re-authenticating...`,
        );
        await secretsManager.updateCredentials(key, {
          username: credentials.username,
          password: credentials.password,
          token: undefined,
          expiresAt: undefined,
        });
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

    let last: AdapterResponse = { success: false, error: "Login did not run" };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        console.log(
          `[SportLots Adapter] retry attempt ${attempt}/${MAX_ATTEMPTS} — previous error: ${last.error}`,
        );
      }
      last = await this.attemptLogin(key, attempt);
      if (last.success) return last;
      if (!last.retryable || attempt === MAX_ATTEMPTS) return last;
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
  private async attemptLogin(key: string, attempt: number): Promise<AdapterResponse> {
    const t0 = Date.now();
    const log = (msg: string) =>
      console.log(`[SportLots Adapter] ${msg} (t+${Date.now() - t0}ms, attempt ${attempt}/${MAX_ATTEMPTS})`);
    try {
      log("login start");
      const secretsManager = new SecretsManagerService();
      const credentials = await secretsManager.getCredentials(key);
      if (!credentials.username || !credentials.password) {
        log("credentials missing username/password");
        return {
          success: false,
          error: "Invalid credentials format",
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
        // Most often a blank/slow body from SL; retry once. If SL genuinely
        // changed their response format we'll see it in the preview over
        // multiple retries. This is also the "Not a valid Email Address"
        // case the diagnostics work targets — build a sanitized diagnostic
        // from the response body (redacted of the typed email/password).
        const preview = responseBody.slice(0, 200).replace(/\s+/g, " ");
        log(`no cookies parsed; body preview: ${preview}`);
        const diagnostic = buildLoginDiagnostic(
          { url: loginUrl, rawText: responseBody },
          { email: credentials.username, password: credentials.password },
        );
        log(`no-cookies diagnostic: challengeDetected=${diagnostic.challengeDetected}`);
        return {
          success: false,
          error: "No session cookies received. Check credentials.",
          retryable: true,
          diagnostic,
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
        const preview = validateBody.slice(0, 200).replace(/\s+/g, " ");
        log(`validation body contained login/signin reference; preview: ${preview}`);
        const diagnostic = buildLoginDiagnostic(
          { url: loginUrl, rawText: validateBody },
          { email: credentials.username, password: credentials.password },
        );
        log(`validation-failed diagnostic: challengeDetected=${diagnostic.challengeDetected}`);
        return {
          success: false,
          error: "SportLots login validation failed. Cookies did not authenticate.",
          diagnostic,
        };
      }

      // Store the cookie + TTL so login() can short-circuit on the next
      // call. Without expiresAt, the cache-hit branch above can never fire.
      const expiresAt = Date.now() + CACHED_TOKEN_TTL_MS;
      await secretsManager.updateCredentials(key, {
        username: credentials.username,
        password: credentials.password,
        token: cookieString,
        expiresAt,
      });
      log("login success; token stored");

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
