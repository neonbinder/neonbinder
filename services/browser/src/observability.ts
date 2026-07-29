import { LoginDiagnostic } from "./services/login-diagnostic";

/**
 * Structured-log helpers for the browser service.
 *
 * Extracted from index.ts (NEO-43) so they are unit-testable: index.ts calls
 * app.listen() at module load, so a test can never import it directly (see
 * the note at the top of tests/credentials-routes.test.mjs). src/rate-limit.ts
 * was extracted for the same reason.
 */

/**
 * Emit a single structured JSON line to stdout so Cloud Run / GCP logging
 * picks it up as a structured log entry. Never throws — falls back to a plain
 * console.log if JSON serialization fails.
 *
 * NEO-43: these lines are now the substrate for the production alert policies
 * in neonbinder_terraform (log-based metrics `browser_login_failures` and
 * `browser_login_duration_ms`). Two consequences:
 *
 *   1. Field names and value shapes are a MONITORING CONTRACT. Renaming a
 *      field silently zeroes a metric — Cloud Monitoring reports no error, the
 *      series just stops, and the alert built on it never fires again. Change
 *      these only in lockstep with the terraform filters/label_extractors.
 *   2. NEVER add page-derived text here (the diagnostic's `snippet`, `title`
 *      or `url`). `snippet` alone can be 1500 chars of marketplace HTML — see
 *      MAX_SNIPPET_CHARS in services/login-diagnostic.ts. Only the
 *      `challengeDetected` BOOLEAN crosses into Cloud Logging.
 *
 * Keep field names aligned with convex/observability.ts so the dashboard can
 * union the two sources.
 */
export function logBrowserOp(props: {
  msg: "browser_login_call";
  operation: string;
  platform: "bsc" | "sportlots";
  duration_ms: number;
  success: boolean;
  status_code?: number;
  error_class?: string;
  /**
   * NEO-43: true when the marketplace served a challenge/block page (captcha,
   * Cloudflare, rate-limit interstitial) rather than authenticating — see
   * CHALLENGE_PATTERNS in services/login-diagnostic.ts.
   *
   * This is the only signal that separates "the marketplace is blocking us"
   * (page us) from "the seller mistyped their password" (do nothing), and
   * without it Cloud Monitoring is structurally blind to the distinction.
   *
   * OMITTED (not `false`) when no diagnostic was captured, so "we looked and
   * saw no challenge" stays distinguishable from "we never looked".
   */
  challenge_detected?: boolean;
  /**
   * NEO-43: true for the synthetic login canary (Cloud Scheduler), false for
   * real caller traffic. Always emitted so the log-based metric's `canary`
   * label is never an empty string.
   *
   * The canary is expected to be the MAJORITY of /login/* traffic at current
   * volumes, so without this label a healthy canary would dilute any
   * seller-facing failure signal into invisibility.
   */
  canary: boolean;
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
 * adapter-perf dashboard and the NEO-43 alert policies. Mirrors
 * convex/observability.ts::classifyAdapterError.
 *
 * The return value is a CLOSED SET of literals — it never interpolates the
 * raw error. That matters because it is now returned to the caller in the
 * HTTP error body (NEO-43): BSC's caller-facing error is deliberately the
 * generic "Authentication failed" so the raw Azure B2C message (which can
 * echo the submitted identifier) never leaves the service, and `error_class`
 * must not reintroduce that leak.
 *
 * Alert policies treat `invalid_credentials` / `bad_key_format` /
 * `missing_key` as CALLER errors and exclude them; everything else pages.
 * A new tag added here defaults to paging — which is the safe direction.
 */
export function classifyBrowserError(raw: string | undefined): string | undefined {
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

/**
 * NEO-98: decide the HTTP status and error_class for a failed login.
 *
 * The contract this establishes, and why it exists:
 *
 *   422 — the marketplace processed the credentials and refused them (or the
 *         stored secret was incomplete). The seller's problem. NEVER pages.
 *   502 — we could not complete the exchange: the marketplace returned
 *         something unusable, was unreachable, or blocked us. Our problem.
 *         PAGES.
 *   500 — reserved for an uncaught throw in our own code (set by the routes'
 *         catch blocks, not here). PAGES.
 *
 * Before this, BSC answered a rejection with 500 and SportLots with 400. That
 * asymmetry is what forced the NEO-43 hang policy to match 499|502|503|504
 * and explicitly EXCLUDE 500 — leaving it with no crash coverage at all,
 * because a container dying mid-request looked exactly like a typo'd
 * password. Splitting rejection (422) from fault (502) is what lets that
 * policy widen to >=500.
 *
 * Note the default: anything the adapter could not positively identify as a
 * rejection returns 502 and therefore pages. Same safe direction as
 * classifyBrowserError above — a new, unclassified failure gets noticed
 * rather than silently absorbed as user error.
 *
 * `raw` is passed separately because the two routes assemble it differently
 * (BSC falls back to `message`). It is only ever fed to classifyBrowserError,
 * which returns a closed set of literals and never echoes it.
 */
export function loginFailureOutcome(
  result: { credentialRejected?: boolean },
  raw: string | undefined,
): { status: 422 | 502; errorClass: string | undefined } {
  if (result.credentialRejected) {
    // Force the tag rather than deriving it. BSC's caller-facing string is
    // deliberately the generic "Authentication failed", which classifies as
    // "other" — and the alert policies exclude `invalid_credentials` as a
    // caller error, so leaving it "other" would keep paging on seller typos
    // through a different door than the status code.
    return { status: 422, errorClass: "invalid_credentials" };
  }
  return { status: 502, errorClass: classifyBrowserError(raw) };
}

/**
 * Options threaded from the HTTP layer into an adapter's login().
 */
export interface LoginOptions {
  /**
   * NEO-43 synthetic canary mode. When true the adapter must:
   *   1. SKIP the cached-token short-circuit, and
   *   2. SKIP writing the freshly-obtained token back to Secret Manager.
   *
   * Both halves are required, and neither is optional:
   *
   *   (1) exists because SportLots caches its session cookie for 30 DAYS
   *       (CACHED_TOKEN_TTL_MS) — a canary without this would exercise the
   *       real SportLots login roughly once a month and would have been blind
   *       to the multi-minute SL login hang that prompted NEO-43.
   *   (2) exists because every fresh login writes a NEW, permanently-enabled
   *       Secret Manager version. At canary cadence that is thousands of
   *       versions a month at $0.06/version/month — more than the rest of
   *       this infrastructure combined. It also makes (1) structurally true
   *       rather than flag-dependent, since no token is ever cached on the
   *       canary key to begin with.
   *
   * Reachable only by the four service accounts holding run.invoker on this
   * service; Convex never sets it.
   */
  canary?: boolean;
}

/**
 * Extract the challenge flag from an adapter diagnostic for the log line.
 * Returns undefined (key omitted) when no diagnostic was captured.
 *
 * Deliberately narrow: this is the ONLY field of LoginDiagnostic permitted to
 * reach Cloud Logging. Do not widen it to return url/title/snippet.
 */
export function challengeFlag(diagnostic: LoginDiagnostic | undefined): boolean | undefined {
  return diagnostic ? diagnostic.challengeDetected === true : undefined;
}
