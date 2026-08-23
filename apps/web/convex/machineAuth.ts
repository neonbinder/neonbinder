/**
 * Machine auth: trade a Clerk API key for a real Clerk session JWT (NEO-172).
 *
 * A headless client — the streaming scanner CLI, a cron box, a developer's
 * script — has no browser and cannot complete an interactive Clerk sign-in. It
 * needs to call the same Convex functions a signed-in user calls, as that user,
 * without anything in this codebase inventing a second notion of identity.
 *
 * ## The shape of the answer
 *
 * This endpoint mints NOTHING of its own. It presents the client's API key to
 * Clerk, and if Clerk vouches for it, asks Clerk for a session token from the
 * `convex` JWT template — the exact same template the browser SDK uses. What
 * comes back is an ordinary Clerk session JWT, so:
 *
 *   - `ctx.auth.getUserIdentity()` validates it through convex/auth.config.ts
 *     with no change whatsoever, because there is nothing special about it;
 *   - `identity.subject` is the real `user_…` id, so `getCurrentUserId` and
 *     every ownership check built on it work unmodified;
 *   - nothing downstream can tell — or needs to tell — a machine caller from a
 *     browser caller.
 *
 * That is the whole design goal. A bespoke token format, a shared bearer
 * secret, or a second identity table would each have required every
 * authorization check in the codebase to learn about a second kind of caller,
 * and the failure mode of getting that wrong is silent cross-user access.
 *
 * ## Trust model
 *
 *  - **The API key is the per-client credential.** It is created and stored by
 *    Clerk, scoped to one user, and revocable from the Clerk dashboard without
 *    a deploy. We never store it, never hash it, never see it again after the
 *    exchange — Clerk is the authority on whether it is still good.
 *  - **`CLERK_SECRET_KEY` lives only in Convex env**, never in a client, never
 *    in the repo, never in a browser bundle. It is what authorizes the three
 *    calls below. A client that could reach it would not need this endpoint.
 *  - **Revocation takes effect within one token lifetime.** Revoking a key
 *    stops the NEXT exchange immediately; a JWT already minted stays valid
 *    until it expires, exactly as a browser session token would. Anything
 *    stronger would mean checking the key on every request, which is precisely
 *    the per-request upstream dependency this exchange exists to avoid. If a
 *    key is ever believed compromised, revoke it AND revoke the user's sessions
 *    in the Clerk dashboard — the second step is what kills the outstanding
 *    tokens.
 *  - **No rate limiting in v1, beyond Clerk's own.** Deliberate, not an
 *    oversight. The exchange is ~3 upstream calls with no database writes, an
 *    attacker without a valid key cannot get past the first one, and Clerk
 *    rate-limits `/api_keys/verify` on its side — so a flood costs us upstream
 *    calls, not data. The structured log line below is the abuse signal: a
 *    burst of `machine_token_exchange_failed` at stage `verify` is what a
 *    guessing attack looks like, and it is what an alert should watch. Revisit
 *    if this endpoint ever grows a side effect.
 *
 * ## What is deliberately NOT touched
 *
 * `verifyClerkToken` and `getClerkUserIdFromToken` in convex/auth.ts are dead
 * code and STAY dead. They verify an inbound JWT with `@clerk/backend`, which is
 * a different job from this one: this endpoint never inspects a JWT, it asks
 * Clerk to issue one. Wiring them in here would create a second, hand-rolled
 * token-validation path alongside the one Convex already performs from
 * auth.config.ts — two places to keep correct, with the weaker one reachable
 * over HTTP. convex/auth.ts and convex/auth.config.ts are unmodified by NEO-172.
 *
 * ## Why creating a session takes three calls instead of one
 *
 * The obvious implementation is `POST /sessions` with the user id. It is one
 * call, it returns a session, and it does not work: Clerk documents that
 * endpoint as **"intended only for use in testing, and is not available for
 * production instances"** (bapi spec 2026-05-12, `createSession`). It succeeds
 * on a development instance and is refused on a production one — the worst
 * possible shape for a bug, because every test and every staging run passes and
 * the failure arrives on release day.
 *
 * Clerk's documented programmatic path is a **sign-in token redeemed as a
 * ticket**, which is what `createSessionViaSignInToken` below does:
 *
 *   1. `POST /sign_in_tokens` (Backend API, our secret key) mints a short-lived
 *      one-time ticket for the user. This is a backend-authorized statement that
 *      the bearer may sign in as `subject`, and nothing more — it is not a
 *      session and cannot be used as one.
 *   2. `POST {FAPI}/v1/client/sign_ins` (Frontend API, NO secret) redeems that
 *      ticket with `strategy=ticket`. This is the call a browser would make, and
 *      it is what actually creates the session; its response carries
 *      `created_session_id`.
 *   3. `POST /sessions/{sid}/tokens/convex` (Backend API again) mints the JWT.
 *      That endpoint carries no testing restriction — only session CREATION was
 *      ever restricted — so this step is unchanged from the original design.
 *
 * Step 2 is the only Frontend API call in this file, and it is the reason the
 * session cache matters beyond saving a round trip: a client that holds onto its
 * `sessionId` performs this dance ONCE and then reuses the session until it
 * expires. That keeps the FAPI hop — the one call that looks like a browser and
 * is therefore the one most exposed to bot protection — on the rare path rather
 * than on every exchange.
 *
 * ### The dev-browser branch
 *
 * Development instances (`*.accounts.dev`) can refuse a FAPI sign-in that
 * arrives without a dev-browser context. When the refusal says so, we fetch one
 * from `POST {FAPI}/v1/dev_browser` and retry once with `__clerk_db_jwt`. That
 * endpoint does not exist on production instances, so the branch is gated on
 * what the error actually SAYS rather than on the hostname — a hostname guess
 * would either call a 404 route in production or miss a custom dev domain.
 */

import { httpAction } from "./_generated/server";

/** Clerk Backend API root. Every call below is `${CLERK_API_BASE}${path}`. */
const CLERK_API_BASE = "https://api.clerk.com/v1";

/**
 * The JWT template to mint from — the SAME one the browser SDK uses, which is
 * what makes the resulting token indistinguishable from a browser session's.
 * Must match `applicationID` in convex/auth.config.ts (`aud: "convex"`).
 */
const CONVEX_JWT_TEMPLATE = "convex";

/**
 * Subjects we will mint for. Clerk API keys can be scoped to a user, an
 * organization or a machine (`^(user|org|mch)_\w{27}$` in the spec's api_key
 * object); only a user subject has a Convex identity to act as. An org- or
 * machine-scoped key is a perfectly valid key that simply has no user behind it,
 * and it gets the same 401 as a bad one — see `unauthorized`.
 *
 * Deliberately the same shape as `CLERK_USER_ID_RE` in
 * convex/lib/placeholderObjects.ts rather than the spec's stricter 27-character
 * form: this repo's existing rule is what every ownership check downstream
 * already assumes, and a subject that passes here but fails there would be a
 * token nothing accepts.
 */
const MACHINE_SUBJECT_RE = /^user_[A-Za-z0-9]+$/;

/**
 * Session ids we will look up. `sessionId` is the one client-supplied value
 * that gets interpolated into an upstream URL PATH, so it is shape-checked
 * before it goes anywhere near one — a `../` or a percent-encoded separator in
 * an unchecked value would let a caller aim the GET at a different Clerk
 * resource entirely. Structurally unrepresentable beats rejected-if-noticed.
 *
 * **Length-bounded**, not just character-bounded. A real Clerk session id is
 * around 30 characters; 120 is generous headroom for a format change. Without an
 * upper bound the character class alone would happily accept a megabyte of `A`s
 * and put it in an outbound URL — see MAX_PRESENTED_KEY_CHARS for why an
 * unauthenticated caller must not be able to size our upstream traffic.
 *
 * A malformed id is not a credential failure, so it is ignored and the exchange
 * falls through to creating a session, exactly as a missing one does. That
 * covers the over-length case too: no distinct answer, no new signal.
 */
const SESSION_ID_RE = /^sess_[A-Za-z0-9]{1,120}$/;

/**
 * Longest presented key we will forward to Clerk.
 *
 * This is an **outbound amplification** bound, not a validation nicety, and the
 * distinction matters because the obvious reading ("Clerk will reject a silly
 * key anyway") misses the problem. Everything in this handler up to the verify
 * call is UNAUTHENTICATED: anyone who can reach the route can put an arbitrary
 * number of bytes in `key`, and those bytes were previously copied verbatim into
 * a request body that we send to `api.clerk.com` **carrying CLERK_SECRET_KEY**.
 * So an anonymous caller could make our deployment emit large authenticated
 * requests on their behalf — spending our egress, our Clerk rate limit, and our
 * reputation with an upstream that sees a credential of ours attached.
 *
 * 512 characters is far past any real `ak_…` secret and still small enough that
 * the amplification factor is negligible. An over-length key gets the SAME
 * constant 401 as every other bad credential — it is one more indistinguishable
 * rejection, not a new error class to probe with.
 */
const MAX_PRESENTED_KEY_CHARS = 512;

/**
 * Verify-stage statuses that mean "ask again later", not "your key is bad".
 *
 * 5xx is the obvious case and is handled alongside these. The two here are the
 * non-obvious ones, and 429 is the one that matters:
 *
 *  - **429 Too Many Requests.** Clerk rate-limits `/api_keys/verify` at the
 *    INSTANCE level, so the budget is shared by every client of this deployment.
 *    That makes a 429 a statement about contention, not about the credential —
 *    and, critically, contention an ATTACKER CAN INDUCE by spraying junk keys.
 *    Treating it as 401 would mean anyone able to exhaust the instance's verify
 *    budget could make every legitimate client see "invalid machine key" and
 *    dutifully throw away a perfectly good credential. That turns a transient
 *    denial of service into a persistent one that the victims complete
 *    themselves. 502 says "try again", which is the truth.
 *  - **408 Request Timeout.** Clerk never received a complete request, so it has
 *    not formed an opinion about the key at all.
 *
 * Both are therefore upstream conditions the client should retry, and neither
 * says anything about the key that could serve as an oracle — every caller sees
 * the same 502 under the same contention regardless of what they presented.
 */
const VERIFY_TRANSIENT_STATUSES = new Set([408, 429]);

/**
 * Per-call upstream timeout.
 *
 * Without one a hung Clerk connection holds the HTTP action open until the
 * platform kills it, and the client sees a timeout it cannot distinguish from a
 * hang of ours. Ten seconds is far past Clerk's normal latency and well inside
 * any sane client timeout, so a stall becomes a prompt, retryable 502.
 */
const CLERK_TIMEOUT_MS = 10_000;

/**
 * Lifetime of the sign-in ticket, in seconds.
 *
 * Clerk's default is 30 days; this one is redeemed by the very next call in the
 * same handler, so its useful life is milliseconds. Sixty seconds is slack for a
 * slow hop, not a window anyone is meant to hold it open in — and it is the
 * blast radius if the ticket ever escapes, since a ticket is a bearer credential
 * that signs its holder in as `subject`. It is also single-use: redeeming it
 * moves the token's `status` from `pending` to `accepted`.
 */
const SIGN_IN_TOKEN_TTL_SECONDS = 60;

// ---------------------------------------------------------------------------
// Responses — constant shapes, no exceptions
// ---------------------------------------------------------------------------
//
// Exactly three bodies leave this endpoint on failure, and each is a fixed
// string. That is the anti-oracle property, and it is worth stating why it has
// to be this absolute: a caller holding a candidate key learns something from
// ANY difference between "no such key", "revoked key", "expired key", "org-
// scoped key" and "valid key belonging to someone else". Distinct messages, or
// even distinct status codes, turn this endpoint into a way to enumerate and
// classify keys. So every rejection in the credential path returns the same
// bytes with the same status, and the diagnostic detail goes to the log, which
// only operators can read.
//
// The two non-401 statuses are NOT part of that concern and are deliberately
// different, because they say nothing about the key: 503 means this deployment
// is not configured for machine auth at all, and 502 means Clerk did not
// answer. Both are the same for every caller and every key.

const UNAUTHORIZED_BODY = '{"error":"invalid machine key"}';
const UPSTREAM_BODY = '{"error":"auth upstream unavailable"}';
const UNCONFIGURED_BODY = '{"error":"machine auth is not configured"}';

function constantResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json",
      // A minted token must never be cached by anything between us and the
      // client; the error responses carry the same header so the whole endpoint
      // has one caching story rather than two.
      "cache-control": "no-store",
    },
  });
}

/** Every credential-path rejection, without exception. */
function unauthorized(): Response {
  return constantResponse(401, UNAUTHORIZED_BODY);
}

/** Clerk was unreachable, slow, or answered in a way we cannot act on. */
function upstreamUnavailable(): Response {
  return constantResponse(502, UPSTREAM_BODY);
}

/** CLERK_SECRET_KEY is not set on this deployment. */
function notConfigured(): Response {
  return constantResponse(503, UNCONFIGURED_BODY);
}

// ---------------------------------------------------------------------------
// Logging — status codes and public ids only
// ---------------------------------------------------------------------------
//
// NOTHING secret is ever passed to these. Not the presented key, not the minted
// JWT, not a Clerk response body. Clerk error bodies in particular are excluded
// on purpose: they are another service's text, they can carry request context we
// have no reason to retain, and a log line is the easiest place for a secret to
// end up somewhere it is not protected. What is logged is what an operator can
// act on — which stage failed, the HTTP status, and the key's PUBLIC id
// (`ak_…`, the identifier Clerk shows in its dashboard, not the secret).

/** The one success line. `keyId` is the public `ak_…` id, never the secret. */
function logExchange(keyId: string, subject: string, reusedSession: boolean): void {
  console.log(
    JSON.stringify({
      msg: "machine_token_exchange",
      keyId,
      subject,
      reusedSession,
    }),
  );
}

/**
 * The failure line. `stage` is the low-cardinality tag to group and alert on
 * (`verify`, `create_session`, `mint`, …) and `status` is the upstream HTTP
 * status when there was one — the same discipline `classifyAdapterError`
 * enforces for adapter telemetry: group on the tag, never on a message.
 *
 * `keyId` is present only once verification has succeeded, which is precisely
 * when we have a public id to name. A failure at `verify` has no key to
 * identify, and inventing one from the presented secret is the mistake this
 * whole file is arranged to avoid.
 */
function logFailure(stage: string, status?: number, keyId?: string): void {
  console.warn(
    JSON.stringify({
      msg: "machine_token_exchange_failed",
      stage,
      ...(status !== undefined ? { status } : {}),
      ...(keyId !== undefined ? { keyId } : {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// Upstream helpers
// ---------------------------------------------------------------------------

/**
 * One Clerk Backend API call.
 *
 * Returns the raw `Response` so each caller can decide what its own statuses
 * mean; throws only for the cases where there is no status at all (connection
 * failure, DNS, timeout). Body parsing is the caller's job for the same reason.
 *
 * Every call site catches that throw and answers 502, which is why the thrown
 * value is a plain `Error` rather than a bespoke class — nothing inspects it,
 * and a type nobody branches on is a concept to maintain for free. The try
 * block is deliberately narrow (one `fetch`, plus `JSON.stringify` of an object
 * this file built) so a bare catch cannot swallow much beyond what it is for.
 *
 * `AbortSignal.timeout` is available in Convex's default runtime — see
 * convex/adapters/espn.ts, which is not a `"use node"` module and uses it the
 * same way.
 */
async function clerkFetch(
  secretKey: string,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<Response> {
  try {
    return await fetch(`${CLERK_API_BASE}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${secretKey}`,
        "content-type": "application/json",
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(CLERK_TIMEOUT_MS),
    });
  } catch (err) {
    // Only the error's NAME survives ("TimeoutError", "TypeError"). The message
    // is deliberately dropped — it can carry the request URL, and a log line is
    // not where we want to discover that a URL was one day built with a
    // credential in it.
    throw new Error(err instanceof Error ? err.name : "fetch_failed");
  }
}

/**
 * Parse a JSON body into a plain object, or null. Never throws.
 *
 * Typed structurally rather than as `Response` so the same parser handles the
 * INBOUND request too — a hand-written request body and an upstream reply need
 * exactly the same treatment here (absent, truncated and not-JSON all have to
 * become `null` rather than an exception), and two copies of that would be two
 * chances to get the swallow wrong.
 */
async function readJson(
  source: { json: () => Promise<unknown> },
): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await source.json();
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A string field, or undefined for anything else (including null). */
function stringField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A string field, looked for at the top level and then one level down under
 * `response`.
 *
 * The Frontend API sometimes wraps its payload in a `{ client, response }`
 * envelope and sometimes returns it flat, depending on the endpoint and on
 * `_is_native`. Both shapes are legitimate, so both are read rather than one
 * being guessed at — guessing wrong here surfaces as "no session id" on an
 * otherwise-successful sign-in, which reads as a Clerk outage.
 */
function envelopeField(
  body: Record<string, unknown> | null,
  name: string,
): string | undefined {
  if (!body) return undefined;
  const direct = stringField(body, name);
  if (direct) return direct;
  const nested = body.response;
  return nested && typeof nested === "object"
    ? stringField(nested as Record<string, unknown>, name)
    : undefined;
}

// ---------------------------------------------------------------------------
// Frontend API
// ---------------------------------------------------------------------------

/**
 * Normalise `CLERK_FRONTEND_API_URL` into a scheme-qualified origin with no
 * trailing slash.
 *
 * The same variable is read by convex/auth.config.ts as the JWT issuer
 * `domain`, so it is already set on every deployment and is already the
 * instance's Frontend API host — there is no second thing to configure. It is
 * normalised rather than trusted verbatim because a trailing slash would
 * produce `//v1/client/sign_ins`, which some proxies answer differently, and a
 * missing scheme would make `fetch` reject the URL outright.
 *
 * Returns null for anything unusable, and the caller answers 503. Three things
 * count as unusable, and each was previously a different kind of wrong:
 *
 *  - **Explicit `http://`.** Refused outright rather than upgraded. The sign-in
 *    ticket is a bearer credential that signs its holder in as the subject, and
 *    it travels in this request body; cleartext is never an acceptable transport
 *    for it. Silently rewriting the scheme would be worse than refusing —
 *    the operator would believe they had configured http and get https, so the
 *    next value they set with a real mistake in it would also be "fixed".
 *  - **A value that is not a URL at all** — whitespace, a bare `https://` with
 *    no host, a stray quote from a copy-paste. This used to pass the caller's
 *    truthiness check and then throw an unhandled `TypeError` inside `new URL()`
 *    at request time, which is a FOURTH response shape (a platform 500) from an
 *    endpoint whose whole error contract is three constant bodies — and one that
 *    can echo the configured origin in its message.
 *  - A URL whose host is empty.
 *
 * `URL.origin` is what comes back, so the result is scheme + host + port and
 * nothing else: any path, query or fragment someone appended is dropped rather
 * than concatenated into `{origin}/v1/client/sign_ins`.
 */
function frontendApiOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // A scheme-less value is assumed https (the common way this is configured);
  // an explicit http:// is preserved here so the check below can REFUSE it
  // rather than quietly upgrading it.
  //
  // No trailing-slash strip: `URL.origin` drops the path for us, and doing it by
  // hand FIRST was a real bug — it turned a bare `"https://"` into `"https:"`,
  // which then failed the scheme test, got prefixed to `"https://https:"`, and
  // parsed as the perfectly valid host `https`. A misconfiguration became a
  // confident request to the wrong origin.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname.length === 0) return null;
  return parsed.origin;
}

/**
 * One Frontend API call.
 *
 * Deliberately carries NO `Authorization` header. The Frontend API is the
 * public, browser-facing surface — it is authorized by the ticket in the body,
 * not by our deployment secret — and sending `CLERK_SECRET_KEY` to it would put
 * a backend credential on a public endpoint for no benefit whatsoever. The
 * separation is the point: this is the one call in the file that a browser
 * could also legitimately make.
 *
 * Form-encoded rather than JSON because that is what the sign-in endpoint
 * expects.
 */
async function fapiPost(
  origin: string,
  path: string,
  opts: { form?: Record<string, string>; query?: Record<string, string> } = {},
): Promise<Response> {
  try {
    // Inside the try, not above it. `origin` has already been validated by
    // `frontendApiOrigin`, so this cannot realistically throw — but "cannot
    // realistically throw" is exactly the reasoning that produced the unhandled
    // TypeError this moved to fix. Constructing it here means ANY failure to
    // build the request becomes the same 502 as a failure to send it, and the
    // endpoint keeps its three-constant-bodies contract no matter what.
    const url = new URL(`${origin}${path}`);
    for (const [name, value] of Object.entries(opts.query ?? {})) {
      url.searchParams.set(name, value);
    }
    return await fetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      ...(opts.form ? { body: new URLSearchParams(opts.form).toString() } : {}),
      signal: AbortSignal.timeout(CLERK_TIMEOUT_MS),
    });
  } catch (err) {
    // Name only — see the note on `clerkFetch`. The URL is especially unwelcome
    // here because the dev-browser retry puts a token in the query string.
    throw new Error(err instanceof Error ? err.name : "fetch_failed");
  }
}

/**
 * Does this Frontend API error mean "you need a dev-browser context"?
 *
 * Matched on what the error SAYS, not on whether the host ends in
 * `.accounts.dev`. A hostname test would be wrong in both directions: an
 * instance on a custom development domain would never get the retry it needs,
 * and — worse — a production instance would be sent to `POST /v1/dev_browser`,
 * a route that does not exist there, turning one clean failure into two.
 *
 * Deliberately loose about the exact spelling (`dev_browser`, `dev browser`,
 * `devbrowser`) because the code is Clerk's to change and the cost of a miss is
 * a 502 the client retries, while the cost of a false positive is one wasted
 * call on a request that was already failing.
 */
const DEV_BROWSER_HINT_RE = /dev[\s_-]?browser/i;

function indicatesDevBrowserRequired(body: Record<string, unknown> | null): boolean {
  if (!body || !Array.isArray(body.errors)) return false;
  return body.errors.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const record = entry as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : "";
    const message = typeof record.message === "string" ? record.message : "";
    return DEV_BROWSER_HINT_RE.test(code) || DEV_BROWSER_HINT_RE.test(message);
  });
}

// ---------------------------------------------------------------------------
// Session creation — the production-legal path
// ---------------------------------------------------------------------------

/**
 * Create a session for `subject` and return its id, or null on any failure.
 *
 * See the module comment for why this is three calls rather than
 * `POST /sessions`. Null rather than a thrown error, and null for EVERY failure
 * mode, because the caller's response is the same 502 either way — the key was
 * already verified, so nothing that happens in here is ever the caller's
 * credential. Each failure logs its own stage first, which is where the
 * diagnostic detail lives.
 *
 * Nothing secret crosses this function's boundary: the ticket is created,
 * redeemed and discarded inside it, and only the resulting session id comes
 * back.
 */
async function createSessionViaSignInToken(
  secretKey: string,
  fapiOrigin: string,
  subject: string,
  keyId: string,
): Promise<string | null> {
  // ---- 1. Mint a one-time sign-in ticket (Backend API) --------------------
  let ticketResponse: Response;
  try {
    ticketResponse = await clerkFetch(secretKey, "/sign_in_tokens", {
      method: "POST",
      body: { user_id: subject, expires_in_seconds: SIGN_IN_TOKEN_TTL_SECONDS },
    });
  } catch {
    logFailure("sign_in_token_unreachable", undefined, keyId);
    return null;
  }
  if (ticketResponse.status !== 200) {
    logFailure("sign_in_token", ticketResponse.status, keyId);
    return null;
  }
  const ticketBody = await readJson(ticketResponse);
  // `token` is present on creation but is NOT in the schema's `required` list —
  // Clerk omits it when the object is read back later. Absent here means we have
  // nothing to redeem, which is an upstream problem rather than a bad request.
  const ticket = ticketBody ? stringField(ticketBody, "token") : undefined;
  if (!ticket) {
    logFailure("sign_in_token_unparseable", ticketResponse.status, keyId);
    return null;
  }

  // ---- 2. Redeem it as a ticket (Frontend API) ----------------------------
  const signInForm = { strategy: "ticket", ticket };
  let signInResponse: Response;
  try {
    signInResponse = await fapiPost(fapiOrigin, "/v1/client/sign_ins", {
      query: { _is_native: "1" },
      form: signInForm,
    });
  } catch {
    logFailure("fapi_sign_in_unreachable", undefined, keyId);
    return null;
  }
  let signInBody = await readJson(signInResponse);

  // The dev-browser retry. Gated on the error's own wording (see
  // `indicatesDevBrowserRequired`), so a production instance never reaches
  // `/v1/dev_browser` — a route that does not exist there.
  if (signInResponse.status >= 400 && indicatesDevBrowserRequired(signInBody)) {
    let devBrowserResponse: Response;
    try {
      devBrowserResponse = await fapiPost(fapiOrigin, "/v1/dev_browser");
    } catch {
      logFailure("dev_browser_unreachable", undefined, keyId);
      return null;
    }
    if (devBrowserResponse.status < 200 || devBrowserResponse.status >= 300) {
      logFailure("dev_browser", devBrowserResponse.status, keyId);
      return null;
    }
    const devBrowserToken = envelopeField(await readJson(devBrowserResponse), "token");
    if (!devBrowserToken) {
      logFailure("dev_browser_unparseable", devBrowserResponse.status, keyId);
      return null;
    }

    try {
      signInResponse = await fapiPost(fapiOrigin, "/v1/client/sign_ins", {
        // The dev-browser token rides in the query string because that is where
        // Clerk's own clients put it. It is a secret, which is exactly why the
        // catch in `fapiPost` refuses to carry a URL into an error message.
        query: { _is_native: "1", __clerk_db_jwt: devBrowserToken },
        form: signInForm,
      });
    } catch {
      logFailure("fapi_sign_in_unreachable", undefined, keyId);
      return null;
    }
    signInBody = await readJson(signInResponse);
  }

  if (signInResponse.status < 200 || signInResponse.status >= 300) {
    // 502, not 401, even for a 4xx: the api key was verified two steps ago, so a
    // refusal here is Clerk's or ours, never the caller's credential.
    logFailure("fapi_sign_in", signInResponse.status, keyId);
    return null;
  }

  const createdSessionId = envelopeField(signInBody, "created_session_id");
  // Shape-checked before it is returned, because the caller interpolates it into
  // the mint URL's PATH. It comes from Clerk rather than from a client, but the
  // rule that no unvalidated string becomes a path segment does not get an
  // exception for a trusted source — it is the property that makes the check
  // easy to keep.
  if (!createdSessionId || !SESSION_ID_RE.test(createdSessionId)) {
    logFailure("fapi_sign_in_unparseable", signInResponse.status, keyId);
    return null;
  }
  return createdSessionId;
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/**
 * Pull the presented key and the optional session id out of the request.
 *
 * Two ways to present the key — a JSON body field and an `Authorization: Bearer`
 * header — because headless clients differ in which is natural: a `curl` script
 * reaches for the header, an SDK reaches for the body. **The body wins** when
 * both are present, which is an arbitrary but fixed rule; what matters is that
 * it IS fixed, so a client that accidentally sends two different keys gets a
 * deterministic answer rather than one that depends on our parsing order.
 *
 * A malformed body is treated as an absent one rather than a 400: a request
 * with no usable key is a request with a bad credential, and it gets the same
 * 401 as every other bad credential. A distinct "malformed JSON" status would
 * be one more bit of feedback for someone probing the endpoint.
 */
async function readCredentials(
  request: Request,
): Promise<{ key?: string; sessionId?: string }> {
  const header = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim();

  // `readJson` swallows an absent, truncated or non-JSON body into null, so
  // there is nothing further to guard against here.
  const body = await readJson(request);

  const bodyKey = body ? stringField(body, "key") : undefined;
  const sessionId = body ? stringField(body, "sessionId") : undefined;

  return {
    key: bodyKey ?? (bearer && bearer.length > 0 ? bearer : undefined),
    sessionId,
  };
}

// ---------------------------------------------------------------------------
// The exchange
// ---------------------------------------------------------------------------

/**
 * `POST /machine/token` — see the module comment for the trust model.
 *
 * Request:  `{ "key": "ak_…", "sessionId": "sess_…" }` (sessionId optional;
 *           the key may instead be sent as `Authorization: Bearer ak_…`).
 * Response: `200 { "token": "<session JWT>", "sessionId": "sess_…" }`.
 *
 * Only the VERIFY step can produce a 401. Once Clerk has vouched for the key,
 * the caller's credential is known good, and a later failure to create a session
 * or mint a token is an upstream problem — reporting it as 401 would send a
 * client with a perfectly valid key off to regenerate it. Everything after
 * verify therefore fails as 502.
 */
export const exchangeMachineToken = httpAction(async (_ctx, request) => {
  // Fail closed. A deployment without the secret cannot authenticate anything,
  // and 503 says "not here, not now" rather than "your key is bad" — a client
  // pointed at the wrong deployment should be told to look at the deployment.
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    logFailure("unconfigured");
    return notConfigured();
  }

  // Checked HERE rather than at the point of use, even though only the
  // create-session path needs it. A deployment missing it would otherwise serve
  // every session-reuse request happily and fail only when a client's session
  // eventually expired — a latent misconfiguration that surfaces hours later,
  // on a different request, as a 502. Failing every request immediately is the
  // honest report of "this deployment is not configured for machine auth".
  //
  // Already set on dev and prod: convex/auth.config.ts reads the same variable
  // as the JWT issuer domain, so there is nothing new to provision.
  const frontendApiUrl = process.env.CLERK_FRONTEND_API_URL;
  if (!frontendApiUrl) {
    logFailure("unconfigured_fapi");
    return notConfigured();
  }
  // Parsed and validated ONCE, up front, rather than at the point of use. Same
  // argument as the presence check above — a deployment configured with an
  // unusable value should say so on every request, not on the first one that
  // happens to need a new session. The stage is distinct from `unconfigured_fapi`
  // so an operator can tell "you did not set it" from "what you set is not an
  // https origin"; the value itself is never logged.
  const fapiOrigin = frontendApiOrigin(frontendApiUrl);
  if (!fapiOrigin) {
    logFailure("unconfigured_fapi_invalid");
    return notConfigured();
  }

  const { key, sessionId } = await readCredentials(request);
  // Length checked HERE, before the key is put in an outbound request body that
  // carries our secret key — see MAX_PRESENTED_KEY_CHARS. Same constant 401 as a
  // missing or bad key, so this adds a bound without adding a signal.
  if (!key || key.length > MAX_PRESENTED_KEY_CHARS) {
    logFailure(key ? "key_too_long" : "missing_key");
    return unauthorized();
  }

  // ---- 1. Verify the presented key ---------------------------------------
  let verifyResponse: Response;
  try {
    verifyResponse = await clerkFetch(secretKey, "/api_keys/verify", {
      method: "POST",
      body: { secret: key },
    });
  } catch {
    logFailure("verify_unreachable");
    return upstreamUnavailable();
  }

  if (
    verifyResponse.status >= 500 ||
    VERIFY_TRANSIENT_STATUSES.has(verifyResponse.status)
  ) {
    // Clerk is broken or busy, not the key. A 401 here would tell a client with
    // a good key to throw it away.
    logFailure("verify", verifyResponse.status);
    return upstreamUnavailable();
  }
  if (verifyResponse.status !== 200) {
    // Every REMAINING 4xx collapses to one answer: unknown key, malformed key,
    // revoked key — all indistinguishable from outside.
    logFailure("verify", verifyResponse.status);
    return unauthorized();
  }

  const apiKey = await readJson(verifyResponse);
  if (!apiKey) {
    // A 200 we cannot parse is a broken upstream rather than a bad key, and it
    // is plausibly transient (a truncated response mid-deploy looks like this),
    // so it is retryable — the same call the preprocess adapter makes for a
    // non-JSON 200.
    logFailure("verify_unparseable", verifyResponse.status);
    return upstreamUnavailable();
  }

  // `revoked` and `expired` are required booleans on the api_key object. Tested
  // for the positive value rather than falsiness so a missing or wrongly-typed
  // field cannot read as "still good" — but note the ordering: Clerk already
  // refuses a revoked key at the endpoint above, so this is defence in depth
  // against a future response shape, not the primary control.
  if (apiKey.revoked === true || apiKey.expired === true) {
    logFailure("verify_revoked", verifyResponse.status);
    return unauthorized();
  }

  const subject = stringField(apiKey, "subject");
  const keyId = stringField(apiKey, "id") ?? "unknown";
  if (!subject || !MACHINE_SUBJECT_RE.test(subject)) {
    // An org- or machine-scoped key: valid, but with no user to act as.
    logFailure("verify_subject", verifyResponse.status, keyId);
    return unauthorized();
  }

  // ---- 2. Reuse the caller's session when they own it ---------------------
  //
  // The ownership check here is load-bearing, and the reason is the step after
  // it: the mint endpoint will issue a token for ANY session id we hand it,
  // with no reference to the key we just verified. So an unchecked
  // client-supplied `sessionId` would make this endpoint a token oracle — a
  // caller with any valid key of their own could name another user's session
  // and be handed a JWT for that user. Requiring `user_id === subject` is what
  // keeps the token bound to the identity the key actually proved.
  //
  // Reuse is an optimisation (it avoids creating a session per exchange), so
  // every "no" simply falls through to creating one. The only failure that does
  // NOT fall through is Clerk being down, which is handled as 502 like every
  // other upstream failure — quietly creating a session while Clerk is
  // misbehaving would hide the problem behind a slow path.
  let resolvedSessionId: string | undefined;
  if (sessionId && SESSION_ID_RE.test(sessionId)) {
    let sessionResponse: Response;
    try {
      sessionResponse = await clerkFetch(secretKey, `/sessions/${sessionId}`, {
        method: "GET",
      });
    } catch {
      logFailure("session_unreachable", undefined, keyId);
      return upstreamUnavailable();
    }

    if (sessionResponse.status >= 500) {
      logFailure("session_lookup", sessionResponse.status, keyId);
      return upstreamUnavailable();
    }

    if (sessionResponse.status === 200) {
      const session = await readJson(sessionResponse);
      const owner = session ? stringField(session, "user_id") : undefined;
      const status = session ? stringField(session, "status") : undefined;
      // BOTH conditions, and both are required. "active" alone would accept a
      // live session belonging to someone else; the ownership match alone would
      // accept a revoked or expired one and mint against it.
      if (owner === subject && status === "active") {
        resolvedSessionId = sessionId;
      }
    }
    // Anything else — 404, 4xx, inactive, someone else's — is ignored, without
    // a distinct answer to the caller. A client that guessed at a session id
    // learns only that it got a token for its OWN identity.
  }

  const reusedSession = resolvedSessionId !== undefined;

  // ---- 3. Otherwise create one -------------------------------------------
  //
  // Sign-in ticket → Frontend API redemption, NOT `POST /sessions`: that
  // endpoint is testing-only and is refused on production instances. See the
  // module comment for the full reasoning. Every failure inside is already
  // logged with its stage and is always a 502 — the key was verified above, so
  // nothing in here can be the caller's credential.
  if (!resolvedSessionId) {
    const createdSessionId = await createSessionViaSignInToken(
      secretKey,
      // Already parsed and validated at the top of the handler — not re-derived
      // here, so there is exactly one place that decides what a usable Frontend
      // API origin is.
      fapiOrigin,
      subject,
      keyId,
    );
    if (!createdSessionId) return upstreamUnavailable();
    resolvedSessionId = createdSessionId;
  }

  // ---- 4. Mint the session JWT from the convex template -------------------
  let mintResponse: Response;
  try {
    mintResponse = await clerkFetch(
      secretKey,
      `/sessions/${resolvedSessionId}/tokens/${CONVEX_JWT_TEMPLATE}`,
      { method: "POST", body: {} },
    );
  } catch {
    logFailure("mint_unreachable", undefined, keyId);
    return upstreamUnavailable();
  }

  if (mintResponse.status !== 200) {
    logFailure("mint", mintResponse.status, keyId);
    return upstreamUnavailable();
  }

  const minted = await readJson(mintResponse);
  // The template response field is `jwt`, not `token` — see
  // `CreateSessionTokenFromTemplate` in the bapi spec. It is renamed on the way
  // out so the client shape reads as `{ token, sessionId }`.
  const jwt = minted ? stringField(minted, "jwt") : undefined;
  if (!jwt) {
    logFailure("mint_unparseable", mintResponse.status, keyId);
    return upstreamUnavailable();
  }

  logExchange(keyId, subject, reusedSession);

  return new Response(JSON.stringify({ token: jwt, sessionId: resolvedSessionId }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      // A bearer token must not sit in any shared cache.
      "cache-control": "no-store",
    },
  });
});
