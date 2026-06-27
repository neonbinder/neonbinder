import { SecretsManagerService } from "../services/secrets-manager";
import { LoginDiagnostic } from "../services/login-diagnostic";
import puppeteer, { Browser, Page } from "puppeteer";

export interface LoginCredentials {
  username: string;
  password: string;
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
abstract login(key: string): Promise<AdapterResponse>;

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