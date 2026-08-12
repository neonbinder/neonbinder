import express, { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { SUPPORTED_SITES } from "./adapters";
import { BSCAdapter } from "./adapters/bsc-adapter";
import { SportlotsAdapter } from "./adapters/sportlots-adapter";
import { LoginDiagnostic } from "./services/login-diagnostic";
import { credentialRateLimitKey } from "./rate-limit";
import { createCredentialsRouter } from "./routes/credentials";
import { parseTransientCredentials } from "./transient-credentials";
import {
  logBrowserOp,
  classifyBrowserError,
  challengeFlag,
  loginFailureOutcome,
} from "./observability";

interface LoginResponse {
  success: boolean;
  message?: string;
  expiresAt?: number;
  storeName?: string;
  // BSC seller identifier captured during login; persisted by the Convex
  // layer to userProfiles.marketplaceAccountIds.bscSellerId. Other adapters
  // leave this undefined.
  sellerId?: string;
}

interface ErrorResponse {
  error: string;
  // Sanitized login-failure diagnostic (redacted of credentials/tokens by
  // the adapter). Forwarded by Convex onto its PostHog
  // `credential_test_failed` event so we can see WHAT page caused the
  // failure (e.g. a CAPTCHA/challenge). Omitted when no diagnostic was
  // captured.
  diagnostic?: LoginDiagnostic;
  // NEO-43: the same stable tag written to the browser_login_call log line,
  // so Convex/PostHog and Cloud Logging classify a failure identically
  // instead of PostHog re-deriving one from free text. Convex prefers this
  // over its own classifyAdapterError because BSC's caller-facing error is
  // the deliberately generic "Authentication failed", which local
  // classification can only bucket as "other". Closed set — see
  // classifyBrowserError.
  error_class?: string;
}

// NEO-43: `canary` marks the synthetic Cloud Scheduler login probe. It makes
// the adapter skip both halves of the token cache (read AND write-back) and
// tags the structured log line so alert policies can separate synthetic from
// seller traffic. See LoginOptions in ./observability for the full rationale.
//
// NEO-140/NEO-141: `username`/`password` are OPTIONAL and TRANSIENT. When
// present they drive one fresh sign-in and are never persisted; when absent
// the adapter falls back to the stored secret, which is exactly what the
// canary jobs (`{key, canary:true}`) do. See parseTransientCredentials.
type LoginRequestBody = {
  key: string;
  canary?: boolean;
  username?: string;
  password?: string;
};

interface SitesResponse {
  sites: Record<string, string>;
}

const ENV = process.env.ENVIRONMENT || "dev";
const app = express();

// Trust proxy headers from Cloud Run / load balancers (not in dev — breaks express-rate-limit)
if (ENV !== "dev") {
  app.set("trust proxy", true);
}

// Security middleware
app.use(helmet());
app.use(express.json({ limit: "10kb" }));

// Rate limiting — keyed PER CREDENTIAL KEY (≈ per user+site), NOT per IP.
// See credentialRateLimitKey (./rate-limit) for the full why: Cloud Run IAM
// gates callers to the neonbinder-convex SA, so every request shares that one
// backend's egress IP — an IP-keyed limit was a single global budget that
// parallel users / E2E workers 429'd each other on, silently dropping the
// credential seeds (then the PUT /credentials write, since removed) and
// poisoning the parallel suite.
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // per credential key — ample for one user+site, still catches a runaway loop
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: credentialRateLimitKey,
  validate: ENV === "dev" ? { xForwardedForHeader: false, trustProxy: false } : true,
});
app.use(limiter);

// NEO-20: authentication is now enforced upstream by Cloud Run IAM (only the
// neonbinder-convex service account holds roles/run.invoker on this service).
// We deliberately do not run an app-layer auth check here — Cloud Run rejects
// unauthorized requests with 403 before they ever reach Express. The previous
// x-internal-key middleware was redundant once IAM was in front and a hazard
// when the service was still --allow-unauthenticated. The /health endpoint
// remains public so Cloud Run's HTTP probe can reach it.

// Health endpoint
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", environment: ENV });
});

// Get list of supported sites
app.get("/sites", (_req: Request, res: Response<SitesResponse>) => {
  res.json({ sites: SUPPORTED_SITES });
});

// Site-specific login endpoints
app.post("/login/sportlots", async (req: Request<{}, {}, LoginRequestBody>, res: Response<LoginResponse | ErrorResponse>) => {
  const startMs = Date.now();
  const { key } = req.body;
  // NEO-43: coerce, don't trust. A non-boolean `canary` (e.g. the string
  // "true") would otherwise make the log line claim canary=true while the
  // adapter — which checks `opts?.canary === true` — treated the request as
  // normal. A "normal" run on the canary key writes a token BACK to Secret
  // Manager, silently defeating the cache bypass the canary depends on and
  // resuming the version churn it exists to avoid.
  const canary = req.body.canary === true;
  if (!key) {
    logBrowserOp({
      msg: "browser_login_call",
      operation: "login_sportlots",
      platform: "sportlots",
      duration_ms: Date.now() - startMs,
      success: false,
      status_code: 400,
      error_class: "missing_key",
      canary,
    });
    res.status(400).json({ error: "Missing required field: key" });
    return;
  }
  // NEO-141: optional transient credentials. Rejecting a malformed pair here
  // keeps a caller bug from presenting as a mysterious re-auth loop.
  const transient = parseTransientCredentials(req.body);
  if (!transient.ok) {
    logBrowserOp({
      msg: "browser_login_call",
      operation: "login_sportlots",
      platform: "sportlots",
      duration_ms: Date.now() - startMs,
      success: false,
      status_code: 400,
      error_class: "invalid_credentials",
      canary,
    });
    res.status(400).json({ error: transient.error, error_class: "invalid_credentials" });
    return;
  }
  // Adapter reads credentials from Secret Manager internally. Wrap the call in
  // try/finally so adapter.cleanup() runs no matter what — that closes any
  // Puppeteer Browser child process the adapter launched. SportLots is
  // currently pure HTTP and never launches a browser, but cleanup() is a
  // no-op in that case, and this keeps the invariant (every adapter call is
  // paired with cleanup) uniform across routes. See the OOM root-cause
  // comment on BaseAdapter.launchPage for the failure mode if cleanup is
  // skipped.
  const adapter = new SportlotsAdapter(undefined);
  try {
    const result = await adapter.login(key, {
      canary,
      transientCredentials: transient.credentials,
    });
    if (result.success) {
      logBrowserOp({
        msg: "browser_login_call",
        operation: "login_sportlots",
        platform: "sportlots",
        duration_ms: Date.now() - startMs,
        success: true,
        status_code: 200,
        canary,
      });
      res.json({ success: true, message: result.message });
    } else {
      // NEO-98: 422 when SportLots refused the credentials, 502 when we could
      // not complete the exchange. Was a flat 400 for both.
      const { status, errorClass } = loginFailureOutcome(result, result.error);
      logBrowserOp({
        msg: "browser_login_call",
        operation: "login_sportlots",
        platform: "sportlots",
        duration_ms: Date.now() - startMs,
        success: false,
        // Must track the res.status() below: this field feeds the
        // browser_login_failures log-based metric that the alert policies
        // filter on, so a drift between the two silently lies to monitoring.
        status_code: status,
        error_class: errorClass,
        // NEO-43: boolean only. The rest of the diagnostic (url/title/snippet)
        // is page-derived text and must not enter Cloud Logging.
        challenge_detected: challengeFlag(result.diagnostic),
        canary,
      });
      // Include the sanitized diagnostic (if the adapter captured one) so
      // Convex can attach it to PostHog. result.diagnostic is already
      // redacted of credentials/tokens by buildLoginDiagnostic.
      res.status(status).json({
        error: result.error || "SportLots login failed",
        diagnostic: result.diagnostic,
        error_class: errorClass,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const isBadKey = message.includes("Invalid credential key format");
    const errorClass = classifyBrowserError(message);
    logBrowserOp({
      msg: "browser_login_call",
      operation: "login_sportlots",
      platform: "sportlots",
      duration_ms: Date.now() - startMs,
      success: false,
      status_code: isBadKey ? 400 : 500,
      error_class: errorClass,
      canary,
    });
    if (isBadKey) {
      res.status(400).json({ error: "Invalid credential key format", error_class: errorClass });
    } else {
      // Name + message only, never the error OBJECT. Same rule as
      // secrets-manager.ts's catch: an arbitrary error graph from a client
      // library can carry the request payload it failed on, and on this path
      // that payload is a marketplace credential.
      console.error(
        "Sportlots login failed:",
        err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      );
      res.status(500).json({ error: "Login failed", error_class: errorClass });
    }
  } finally {
    await adapter.cleanup();
  }
});

// BSC login endpoint: accepts username/password, stores in GCP, logs in via Puppeteer
app.post("/login/bsc", async (req: Request<{}, {}, LoginRequestBody>, res: Response<LoginResponse | ErrorResponse>) => {
  const startMs = Date.now();
  const { key } = req.body;
  // NEO-43: coerce, don't trust. A non-boolean `canary` (e.g. the string
  // "true") would otherwise make the log line claim canary=true while the
  // adapter — which checks `opts?.canary === true` — treated the request as
  // normal. A "normal" run on the canary key writes a token BACK to Secret
  // Manager, silently defeating the cache bypass the canary depends on and
  // resuming the version churn it exists to avoid.
  const canary = req.body.canary === true;
  if (!key) {
    logBrowserOp({
      msg: "browser_login_call",
      operation: "login_bsc",
      platform: "bsc",
      duration_ms: Date.now() - startMs,
      success: false,
      status_code: 400,
      error_class: "missing_key",
      canary,
    });
    res.status(400).json({ error: "Missing required field: key" });
    return;
  }
  // NEO-141: optional transient credentials. Rejecting a malformed pair here
  // keeps a caller bug from presenting as a mysterious re-auth loop.
  const transient = parseTransientCredentials(req.body);
  if (!transient.ok) {
    logBrowserOp({
      msg: "browser_login_call",
      operation: "login_bsc",
      platform: "bsc",
      duration_ms: Date.now() - startMs,
      success: false,
      status_code: 400,
      error_class: "invalid_credentials",
      canary,
    });
    res.status(400).json({ error: transient.error, error_class: "invalid_credentials" });
    return;
  }
  // Adapter reads credentials from Secret Manager internally. Wrap the call
  // in try/finally so adapter.cleanup() runs whether login succeeds, fails,
  // or throws. Without this, the Puppeteer Browser child process leaks
  // (~150-200 MiB each) and accumulates across requests on the same Cloud
  // Run instance until the 2048 MiB ceiling OOM-kills the container
  // mid-request — which manifested as the misleading "BSC login failed.
  // Please check your credentials and try again." toast even when BSC
  // accepted the login (the response just never made it back to Convex).
  const adapter = new BSCAdapter(undefined);
  try {
    const result = await adapter.login(key, {
      canary,
      transientCredentials: transient.credentials,
    });
    if (result.success) {
      logBrowserOp({
        msg: "browser_login_call",
        operation: "login_bsc",
        platform: "bsc",
        duration_ms: Date.now() - startMs,
        success: true,
        status_code: 200,
        canary,
      });
      res.json({
        success: true,
        message: result.message,
        expiresAt: result.expiresAt,
        storeName: result.storeName,
        sellerId: result.sellerId,
      });
    } else {
      // NEO-98: 422 when BSC refused the credentials, 502 when the B2C
      // exchange itself failed. Was a flat 500 for both, which is exactly why
      // the NEO-43 hang policy had to exclude 500 and so had no crash
      // coverage. 500 now means only "our code threw" (see the catch below).
      const { status, errorClass } = loginFailureOutcome(
        result,
        result.error || result.message,
      );
      logBrowserOp({
        msg: "browser_login_call",
        operation: "login_bsc",
        platform: "bsc",
        duration_ms: Date.now() - startMs,
        success: false,
        // Must track the res.status() below: this field feeds the
        // browser_login_failures log-based metric that the alert policies
        // filter on, so a drift between the two silently lies to monitoring.
        status_code: status,
        error_class: errorClass,
        // NEO-43: boolean only. The rest of the diagnostic (url/title/snippet)
        // is page-derived text and must not enter Cloud Logging.
        challenge_detected: challengeFlag(result.diagnostic),
        canary,
      });
      // Include the sanitized diagnostic (if the adapter captured one) so
      // Convex can attach it to PostHog. result.diagnostic is already
      // redacted of credentials/tokens by buildLoginDiagnostic.
      res.status(status).json({
        error: result.error || result.message || "BSC login failed",
        diagnostic: result.diagnostic,
        error_class: errorClass,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const isBadKey = message.includes("Invalid credential key format");
    const errorClass = classifyBrowserError(message);
    logBrowserOp({
      msg: "browser_login_call",
      operation: "login_bsc",
      platform: "bsc",
      duration_ms: Date.now() - startMs,
      success: false,
      status_code: isBadKey ? 400 : 500,
      error_class: errorClass,
      canary,
    });
    if (isBadKey) {
      res.status(400).json({ error: "Invalid credential key format", error_class: errorClass });
    } else {
      // Name + message only — see the matching comment on the SportLots route.
      console.error(
        "BSC login failed:",
        err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      );
      res.status(500).json({ error: "BSC login failed", error_class: errorClass });
    }
  } finally {
    await adapter.cleanup();
  }
});

// --- Credential CRUD endpoints ---
//
// NEO-141: these live in ./routes/credentials so the test suite can mount the
// REAL handlers over an in-memory store. They used to be inline here, and
// because this file calls app.listen() at import time a test could never load
// them — tests/credentials-routes.test.mjs re-implemented every handler
// instead, which is why the 404 conflation on GET /credentials/:key/token went
// unnoticed and untested. Keep new credential routes in the router, not here.
app.use(createCredentialsRouter());

const PORT: number = parseInt(process.env.PORT || "8080", 10);
app.listen(PORT, () => console.log(`[${ENV}] Listening on port ${PORT}`));
