import { SecretsManagerService } from "../services/secrets-manager";
import { LoginDiagnostic } from "../services/login-diagnostic";
import { LoginOptions } from "../observability";
import puppeteer, { Browser, Page } from "puppeteer";

// Re-exported so adapters can import LoginOptions alongside AdapterResponse
// from their existing "./base-adapter" import. `export type` keeps it erased
// at runtime — no require() of ../observability is emitted into dist.
export type { LoginOptions };

export interface LoginCredentials {
  username: string;
  password: string;
}

/**
 * NEO-141: the single caller-facing string for "the stored session is gone and
 * we have nothing left to re-establish it with; the user must sign in again".
 *
 * Deliberately one shared constant rather than per-adapter prose:
 * classifyBrowserError in ../observability maps it to the `reauth_required`
 * error_class by substring match, and that class is part of the Terraform
 * log-based-metric contract. Two adapters spelling it differently would put a
 * silent hole in the metric.
 *
 * It says nothing about WHY (expired, revoked, never stored) — that detail
 * stays server-side in the logs.
 */
export const REAUTH_REQUIRED_ERROR = "Re-authentication required";

/**
 * The two NEO-43 synthetic-canary secrets (`bsc-credentials-canary`,
 * `sportlots-credentials-canary`) are the ONLY keys in the platform that still
 * store a marketplace password, because their whole job is to perform a real
 * password sign-in every 30 minutes so the login alerting has something to
 * alert on.
 *
 * SECURITY / OPERATIONAL INVARIANT: no adapter may ever write back to one of
 * these keys. The write-back payload is an explicit field list with no
 * `password` in it, and `updateCredentials` prunes to a single version — so one
 * write-back against a canary key destroys the canary's password permanently,
 * with no history to recover it from.
 *
 * The guard keys off the KEY, not the request's `canary` flag, and that
 * distinction is the whole point. Flag-based protection is caller-dependent: a
 * `POST /login/<site>` carrying the canary key WITHOUT `canary: true` — a
 * terraform edit dropping the field from a scheduler body is enough — would
 * take the ordinary password-login path, succeed, write back, and destroy the
 * password. Every later run then answers 422 `reauth_required`, which the alert
 * policies deliberately exclude as a caller error, so the canary would go
 * permanently and SILENTLY dead while the scheduler kept running green.
 *
 * Before NEO-141 this self-healed by accident: the write-back spread the
 * credentials it had just read, so the password survived. Removing that spread
 * was correct, but it also removed the protection it incidentally provided.
 */
export function isCanaryKey(key: string): boolean {
  return /-credentials-canary$/.test(key);
}

export interface AdapterResponse {
  success: boolean;
  message?: string;
  error?: string;
  storeName?: string;
  /**
   * Marketplace-specific seller / account identifier captured at login time
   * so callers don't have to re-derive it on every API request. For BSC,
   * this is the value used as the `sellerId` field in /search/seller/results
   * request bodies. Persisted to userProfiles.marketplaceAccountIds in the
   * Convex layer.
   */
  sellerId?: string;
  expiresAt?: number;
  /**
   * Set by adapters on `success: false` to indicate whether the caller
   * should retry. Used internally by the adapter's own retry loop; not
   * exposed in the HTTP response.
   */
  retryable?: boolean;
  /**
   * NEO-98: true ONLY when the marketplace demonstrably processed the
   * credentials and refused them. Drives the HTTP status the login routes
   * return: 422 (the seller's problem — never pages) vs 502 (an
   * upstream/integration fault — pages).
   *
   * Leave it UNSET on any branch where you cannot tell the difference. Unset
   * is the safe direction: it pages. Setting it wrongly is the expensive
   * mistake, because it permanently classifies a marketplace outage as user
   * error and Cloud Monitoring goes blind to it.
   *
   * A detected challenge page (diagnostic.challengeDetected) always CLEARS
   * this — being bot-blocked is our problem, not the seller's.
   *
   * Not returned to the caller as-is; it is collapsed into the status code
   * and into `error_class: "invalid_credentials"`.
   */
  credentialRejected?: boolean;
  /**
   * NEO-141: true when the adapter could not authenticate and has nothing left
   * to try — the cached session is dead, the BSC refresh grant was refused (or
   * there is no refresh token), and no transient password was supplied in the
   * request body.
   *
   * This is the signal Convex acts on to tell the user to sign in again. It
   * takes PRECEDENCE over credentialRejected in loginFailureOutcome, and like
   * it yields 422 (never pages) — but under its own `reauth_required`
   * error_class, because "your session expired" and "your password was wrong"
   * need opposite handling upstream.
   *
   * Do NOT set it when a password login was actually attempted and refused:
   * that is credentialRejected. Do not set it for an upstream fault either —
   * an unreachable marketplace must stay pageable.
   */
  reauthRequired?: boolean;
  /**
   * Sanitized login-failure diagnostic. Set by adapters on `success: false`
   * when they could capture context from the stuck/challenge page. SAFE to
   * return to the caller: it is redacted of credentials and tokens by
   * buildLoginDiagnostic (see services/login-diagnostic.ts). The Convex layer
   * forwards this onto its PostHog `credential_test_failed` event.
   */
  diagnostic?: LoginDiagnostic;
}

export abstract class BaseAdapter {
  protected page?: Page;
  protected browser?: Browser;
  protected siteName: string;
  protected token?: string;

  constructor(page: Page | undefined, siteName: string) {
    this.page = page;
    this.siteName = siteName;
  }

  abstract getHomeUrl(): string;

  /**
   * @param opts NEO-43 login options. `opts.canary` puts the adapter in
   * synthetic-probe mode: it MUST skip the cached-token short-circuit and
   * MUST NOT write a freshly-obtained token back to Secret Manager. See
   * LoginOptions in ../observability for why both halves are mandatory.
   * Omitting opts preserves the pre-NEO-43 behaviour exactly.
   */
  abstract login(key: string, opts?: LoginOptions): Promise<AdapterResponse>;

  protected async navigateToHome(): Promise<void> {
    try {
      if (!this.page) throw new Error('No Puppeteer page available in adapter');
      await this.page.goto(this.getHomeUrl(), { waitUntil: "networkidle2" });
    } catch (error) {
      throw new Error(`Failed to navigate to ${this.siteName} home page: ${error}`);
    }
  }

  protected async waitForElement(selector: string, timeout: number = 10000): Promise<void> {
    try {
      if (!this.page) throw new Error('No Puppeteer page available in adapter');
      await this.page.waitForSelector(selector, { timeout });
    } catch (error) {
      throw new Error(`Element not found: ${selector} on ${this.siteName}`);
    }
  }

  /**
   * Launches a fresh Puppeteer browser+page configured for marketplace
   * automation, assigns it to this.page, tracks the Browser handle on
   * this.browser so cleanup() can close it, and returns the page. Use this
   * when an adapter needs a page after the cached-token branch has already
   * run (e.g. BSC re-authenticates after a stale-token 401). If a page is
   * supplied, it's used as-is and no browser is launched (and this.browser
   * is left untouched — the caller owns its lifecycle).
   *
   * Security: callers must not log credentials around the page-launch
   * boundary. The returned page has no credentials attached yet.
   *
   * Memory: every successful launch MUST be paired with a cleanup() call,
   * otherwise the Chromium child process leaks (~150-200 MiB resident) and
   * accumulates across requests on the same Cloud Run instance until the
   * 2048 MiB memory limit OOM-kills the container mid-request. Route
   * handlers are responsible for calling adapter.cleanup() in a finally
   * block so cleanup runs regardless of login success/failure.
   */
  protected async launchPage(page?: Page | null): Promise<Page> {
    if (page) {
      this.page = page;
      return page;
    }
    const browser: Browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1920,1080"],
    });
    const launched = await browser.newPage();
    await launched.setViewport({ width: 1920, height: 1080 });
    this.browser = browser;
    this.page = launched;
    return launched;
  }

  /**
   * Idempotent cleanup of any Puppeteer Browser this adapter launched.
   *
   * Closes this.browser (if set) and resets both this.browser and this.page
   * to undefined so subsequent calls are no-ops. Safe to call when:
   *   - no browser was ever launched (cache-hit path)
   *   - the page was supplied externally — launchPage only sets this.browser
   *     when it actually launches one, so externally-owned browsers are
   *     never closed here
   *   - cleanup() was already called previously
   *
   * Errors closing the browser are caught and logged; never re-thrown, so
   * cleanup in a finally block can't mask the original error.
   */
  async cleanup(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    this.page = undefined;
    if (!browser) return;
    try {
      await browser.close();
    } catch (error) {
      console.error(
        `[${this.siteName} Adapter] cleanup: browser.close() threw:`,
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
    }
  }

  /**
   * Handles browser and token logic for login.
   * If a valid, non-expired token is found, sets this.token and returns { cached: true }.
   * Otherwise, launches a Puppeteer page, sets this.page, and returns { cached: false, page }.
   */
  async loginWithBrowser(key: string, page?: Page | null): Promise<{ cached: boolean; page?: Page }> {
    const secretsManager = new SecretsManagerService();
    const credentials = await secretsManager.getCredentials(key);
    // If credentials have a non-expired token, use it and return
    if (credentials.token && credentials.expiresAt && credentials.expiresAt > Date.now()) {
      this.token = credentials.token;
      return { cached: true };
    }
    // Otherwise, create a browser and page if not provided
    const launched = await this.launchPage(page);
    return { cached: false, page: launched };
  }
} 