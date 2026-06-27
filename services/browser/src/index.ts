import express, { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { SUPPORTED_SITES } from "./adapters";
import { BSCAdapter } from "./adapters/bsc-adapter";
import { SportlotsAdapter } from "./adapters/sportlots-adapter";
import { SecretsManagerService } from "./services/secrets-manager";
import { LoginDiagnostic } from "./services/login-diagnostic";
import { credentialRateLimitKey } from "./rate-limit";

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

/**
 * Emit a single structured JSON line to stdout so Cloud Run / GCP logging
 * picks it up as a structured log entry. Used for the adapter-perf
 * dashboard's browser-service-side timing breakdown. Never throws — falls
 * back to a plain console.log if JSON serialization fails.
 *
 * Keep field names aligned with convex/observability.ts so the dashboard
 * can union the two sources.
 */
function logBrowserOp(props: {
  msg: "browser_login_call" | "browser_op_call";
  operation: string;
  platform: "bsc" | "sportlots";
  duration_ms: number;
  success: boolean;
  status_code?: number;
  error_class?: string;
}): void {
  try {
    console.log(JSON.stringify(props));
  } catch {
    console.log(
      `[browser_login_call] ${props.platform} ${props.operation} ` +
        `duration_ms=${props.duration_ms} success=${props.success}`,
    );
  }
}

/**
 * Map a browser-service login error to a short stable tag for the
 * adapter-perf dashboard. Mirrors convex/observability.ts::classifyAdapterError
 * but covers Puppeteer-specific failure modes too.
 */
function classifyBrowserError(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase();
  if (s.includes("invalid credential key")) return "bad_key_format";
  if (s.includes("timed out") || s.includes("timeout")) return "timeout";
  if (s.includes("invalid") && (s.includes("credential") || s.includes("password")))
    return "invalid_credentials";
  if (s.includes("captcha") || s.includes("challenge")) return "challenge";
  if (s.includes("oom") || s.includes("out of memory")) return "oom";
  return "other";
}

interface ErrorResponse {
  error: string;
  // Sanitized login-failure diagnostic (redacted of credentials/tokens by
  // the adapter). Forwarded by Convex onto its PostHog
  // `credential_test_failed` event so we can see WHAT page caused the
  // failure (e.g. a CAPTCHA/challenge). Omitted when no diagnostic was
  // captured.
  diagnostic?: LoginDiagnostic;
}

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
// credential seeds (PUT /credentials) and poisoning the parallel suite.
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
app.post("/login/sportlots", async (req: Request<{}, {}, { key: string }>, res: Response<LoginResponse | ErrorResponse>) => {
  const startMs = Date.now();
  const { key } = req.body;
  if (!key) {
    logBrowserOp({
      msg: "browser_login_call",
      operation: "login_sportlots",
      platform: "sportlots",
      duration_ms: Date.now() - startMs,
      success: false,
      status_code: 400,
      error_class: "missing_key",
    });
    res.status(400).json({ error: "Missing required field: key" });
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
    const result = await adapter.login(key);
    if (result.success) {
      logBrowserOp({
        msg: "browser_login_call",
        operation: "login_sportlots",
        platform: "sportlots",
        duration_ms: Date.now() - startMs,
        success: true,
        status_code: 200,
      });
      res.json({ success: true, message: result.message });
    } else {
      logBrowserOp({
        msg: "browser_login_call",
        operation: "login_sportlots",
        platform: "sportlots",
        duration_ms: Date.now() - startMs,
        success: false,
        status_code: 400,
        error_class: classifyBrowserError(result.error),
      });
      // Include the sanitized diagnostic (if the adapter captured one) so
      // Convex can attach it to PostHog. result.diagnostic is already
      // redacted of credentials/tokens by buildLoginDiagnostic.
      res.status(400).json({
        error: result.error || "SportLots login failed",
        diagnostic: result.diagnostic,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const isBadKey = message.includes("Invalid credential key format");
    logBrowserOp({
      msg: "browser_login_call",
      operation: "login_sportlots",
      platform: "sportlots",
      duration_ms: Date.now() - startMs,
      success: false,
      status_code: isBadKey ? 400 : 500,
      error_class: classifyBrowserError(message),
    });
    if (isBadKey) {
      res.status(400).json({ error: "Invalid credential key format" });
    } else {
      console.error("Sportlots login failed:", err);
      res.status(500).json({ error: "Login failed" });
    }
  } finally {
    await adapter.cleanup();
  }
});

// BSC login endpoint: accepts username/password, stores in GCP, logs in via Puppeteer
app.post("/login/bsc", async (req: Request<{}, {}, { key: string }>, res: Response<LoginResponse | ErrorResponse>) => {
  const startMs = Date.now();
  const { key } = req.body;
  if (!key) {
    logBrowserOp({
      msg: "browser_login_call",
      operation: "login_bsc",
      platform: "bsc",
      duration_ms: Date.now() - startMs,
      success: false,
      status_code: 400,
      error_class: "missing_key",
    });
    res.status(400).json({ error: "Missing required field: key" });
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
    const result = await adapter.login(key);
    if (result.success) {
      logBrowserOp({
        msg: "browser_login_call",
        operation: "login_bsc",
        platform: "bsc",
        duration_ms: Date.now() - startMs,
        success: true,
        status_code: 200,
      });
      res.json({
        success: true,
        message: result.message,
        expiresAt: result.expiresAt,
        storeName: result.storeName,
        sellerId: result.sellerId,
      });
    } else {
      logBrowserOp({
        msg: "browser_login_call",
        operation: "login_bsc",
        platform: "bsc",
        duration_ms: Date.now() - startMs,
        success: false,
        status_code: 500,
        error_class: classifyBrowserError(result.error || result.message),
      });
      // Include the sanitized diagnostic (if the adapter captured one) so
      // Convex can attach it to PostHog. result.diagnostic is already
      // redacted of credentials/tokens by buildLoginDiagnostic.
      res.status(500).json({
        error: result.error || result.message || "BSC login failed",
        diagnostic: result.diagnostic,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const isBadKey = message.includes("Invalid credential key format");
    logBrowserOp({
      msg: "browser_login_call",
      operation: "login_bsc",
      platform: "bsc",
      duration_ms: Date.now() - startMs,
      success: false,
      status_code: isBadKey ? 400 : 500,
      error_class: classifyBrowserError(message),
    });
    if (isBadKey) {
      res.status(400).json({ error: "Invalid credential key format" });
    } else {
      console.error("BSC login failed:", err);
      res.status(500).json({ error: "BSC login failed" });
    }
  } finally {
    await adapter.cleanup();
  }
});

// --- Credential CRUD endpoints ---

// Store credentials for a key (no marketplace validation)
app.put("/credentials/:key", async (req: Request<{ key: string }, {}, { username: string; password: string }>, res: Response) => {
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: "Missing required fields: username, password" });
    return;
  }
  try {
    const secretsManager = new SecretsManagerService();
    await secretsManager.updateCredentials(req.params.key, { username, password });
    res.json({ success: true, message: "Credentials stored" });
  } catch (err) {
    console.error("Failed to store credentials:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("Invalid credential key format")) {
      res.status(400).json({ error: "Invalid credential key format" });
    } else {
      res.status(500).json({ error: "Failed to store credentials" });
    }
  }
});

// Get credential metadata (no secrets) for a key
app.get("/credentials/:key/metadata", async (req: Request<{ key: string }>, res: Response) => {
  try {
    const secretsManager = new SecretsManagerService();
    const credentials = await secretsManager.getCredentials(req.params.key);
    res.json({
      username: credentials.username,
      hasToken: !!credentials.token,
      expiresAt: credentials.expiresAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("Invalid credential key format")) {
      res.status(400).json({ error: "Invalid credential key format" });
    } else if (message.includes("not found") || message.includes("No active version")) {
      res.status(404).json({ error: "Credentials not found" });
    } else {
      console.error("Failed to retrieve credential metadata:", err);
      res.status(500).json({ error: "Failed to retrieve credential metadata" });
    }
  }
});

// Get token only (for internal adapter use — no username/password exposed)
app.get("/credentials/:key/token", async (req: Request<{ key: string }>, res: Response) => {
  try {
    const secretsManager = new SecretsManagerService();
    const credentials = await secretsManager.getCredentials(req.params.key);
    if (!credentials.token) {
      res.status(404).json({ error: "No token available" });
      return;
    }
    res.json({
      token: credentials.token,
      expiresAt: credentials.expiresAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("Invalid credential key format")) {
      res.status(400).json({ error: "Invalid credential key format" });
    } else if (message.includes("not found") || message.includes("No active version")) {
      res.status(404).json({ error: "Credentials not found" });
    } else {
      console.error("Failed to retrieve token:", err);
      res.status(500).json({ error: "Failed to retrieve token" });
    }
  }
});

// Delete credentials for a key
app.delete("/credentials/:key", async (req: Request<{ key: string }>, res: Response) => {
  try {
    const secretsManager = new SecretsManagerService();
    await secretsManager.deleteCredentials(req.params.key);
    res.json({ success: true, message: "Credentials deleted" });
  } catch (err) {
    console.error("Failed to delete credentials:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("Invalid credential key format")) {
      res.status(400).json({ error: "Invalid credential key format" });
    } else {
      res.status(500).json({ error: "Failed to delete credentials" });
    }
  }
});

// Check which keys have credentials
app.post("/credentials/check", async (req: Request<{}, {}, { keys: string[] }>, res: Response) => {
  const { keys } = req.body || {};
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) {
    res.status(400).json({ error: "Invalid request body: 'keys' must be an array of strings" });
    return;
  }
  try {
    const secretsManager = new SecretsManagerService();
    const results: Record<string, boolean> = {};
    await Promise.all(
      keys.map(async (key) => {
        results[key] = await secretsManager.credentialsExist(key);
      })
    );
    res.json({ results });
  } catch (err) {
    console.error("Failed to check credentials:", err);
    res.status(500).json({ error: "Failed to check credentials" });
  }
});

const PORT: number = parseInt(process.env.PORT || "8080", 10);
app.listen(PORT, () => console.log(`[${ENV}] Listening on port ${PORT}`));
