/**
 * NEO-339 — the Clerk Frontend API (FAPI) calls a headless client needs to turn
 * a sign-in ticket into a `convex` template JWT.
 *
 * This is the browser's own path, spoken from Node in Clerk's "native" mode
 * (`_is_native=1`): there is no cookie jar, so Clerk hands the client JWT back
 * in the `Authorization` RESPONSE header and expects it back, raw, in the
 * `Authorization` REQUEST header of later calls. That is how Clerk's Expo SDK
 * works, and it is what lets a Node process hold a session without cookies.
 *
 * The calls, in order:
 *
 *   1. `POST {fapi}/v1/client/sign_ins?_is_native=1` with the form
 *      `strategy=ticket&ticket=…` redeems the one-time sign-in ticket and
 *      creates the session (`created_session_id`).
 *   2. If a development instance refuses that for want of a dev-browser
 *      context, `POST {fapi}/v1/dev_browser` and retry ONCE with
 *      `__clerk_db_jwt`. Gated on what the refusal SAYS, never on the hostname —
 *      the same rule, and for the same reasons, as `convex/machineAuth.ts`.
 *   3. `POST {fapi}/v1/client/sessions/{sid}/tokens/{template}?_is_native=1`
 *      with the client JWT mints the template token (`{ jwt }`).
 *
 * The Clerk testing token, when the caller has one, rides on every call as
 * `__clerk_testing_token` — exactly what `app/testing/sign-in/page.tsx` does by
 * patching `window.fetch` — so bot protection never challenges the run.
 *
 * Nothing here carries a Clerk SECRET key: FAPI is the public, browser-facing
 * surface, authorized by the ticket and then by the client JWT.
 */

import {
  SetbuildAuthError,
  TRANSIENT_STATUSES,
  defaultFetch,
  redact,
} from "./token-source";

/** Every FAPI call gives up after this long; a hung socket must not hang a seed. */
export const FAPI_TIMEOUT_MS = 15_000;

/** The JWT template Convex accepts — `applicationID` in convex/auth.config.ts. */
export const CONVEX_JWT_TEMPLATE = "convex";

/**
 * Same shape check as `SESSION_ID_RE` in convex/machineAuth.ts: the session id
 * becomes a URL PATH segment, so it is checked even though Clerk produced it.
 */
const SESSION_ID_RE = /^sess_[A-Za-z0-9]{1,64}$/;
const TEMPLATE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEV_BROWSER_HINT_RE = /dev[\s_-]?browser/i;
const FAPI_HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * The FAPI origin encoded in a Clerk publishable key.
 *
 * `pk_(test|live)_` + base64(`<frontend api host>$`). Throws on anything else
 * without echoing the key (a publishable key is not a secret, but a value a
 * user pasted into the wrong variable might be).
 */
export function fapiOriginFromPublishableKey(publishableKey: string): string {
  const match = /^pk_(test|live)_([A-Za-z0-9+/=_-]+)$/.exec(publishableKey.trim());
  if (!match) {
    throw new SetbuildAuthError(
      "publishable_key",
      "VITE_CLERK_PUBLISHABLE_KEY is not a Clerk publishable key (expected pk_test_… or pk_live_…).",
    );
  }
  let decoded: string;
  try {
    decoded = atob(match[2].replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw new SetbuildAuthError("publishable_key", "VITE_CLERK_PUBLISHABLE_KEY does not decode.");
  }
  const host = decoded.endsWith("$") ? decoded.slice(0, -1) : decoded;
  if (!FAPI_HOST_RE.test(host)) {
    throw new SetbuildAuthError(
      "publishable_key",
      "VITE_CLERK_PUBLISHABLE_KEY does not encode a Frontend API host.",
    );
  }
  return `https://${host}`;
}

export interface FapiContext {
  /** `https://<instance>.clerk.accounts.dev` or a custom FAPI origin. */
  origin: string;
  /** Clerk testing token from `/api/auth/testing`, when there is one. */
  testingToken?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** A redeemed ticket: the session, plus what later calls must present. */
export interface FapiSession {
  sessionId: string;
  /** Native-mode client JWT; sent back raw as `Authorization`. */
  clientJwt: string;
  /** Set only when a development instance demanded a dev-browser context. */
  devBrowserJwt?: string;
}

interface FapiResponse {
  status: number;
  body: Record<string, unknown> | null;
  authorization: string | null;
}

function secretsOf(ctx: FapiContext, extra: Array<string | undefined>): string[] {
  return [ctx.testingToken, ...extra].filter((s): s is string => typeof s === "string");
}

/**
 * One FAPI POST. Never lets a URL into an error: the query string carries the
 * testing token and, on a dev instance, the dev-browser JWT.
 */
async function fapiPost(
  ctx: FapiContext,
  path: string,
  opts: {
    form?: Record<string, string>;
    devBrowserJwt?: string;
    authorization?: string;
    stage: string;
  },
): Promise<FapiResponse> {
  const fetchFn = ctx.fetchFn ?? defaultFetch();
  let res: Response;
  try {
    const url = new URL(`${ctx.origin}${path}`);
    url.searchParams.set("_is_native", "1");
    if (ctx.testingToken) url.searchParams.set("__clerk_testing_token", ctx.testingToken);
    if (opts.devBrowserJwt) url.searchParams.set("__clerk_db_jwt", opts.devBrowserJwt);
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
    };
    if (opts.authorization) headers.authorization = opts.authorization;
    res = await fetchFn(url.toString(), {
      method: "POST",
      headers,
      body: new URLSearchParams(opts.form ?? {}).toString(),
      signal: AbortSignal.timeout(ctx.timeoutMs ?? FAPI_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SetbuildAuthError(
      `${opts.stage}_unreachable`,
      `Clerk Frontend API did not answer (${err instanceof Error ? err.name : "fetch failed"}).`,
    );
  }
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(await res.text());
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, authorization: res.headers.get("authorization") };
}

/** Clerk's first error, as `code` + `message`, redacted. */
function clerkError(
  body: Record<string, unknown> | null,
  secrets: string[],
): { code?: string; message?: string } {
  const first = Array.isArray(body?.errors) ? body.errors[0] : undefined;
  if (!first || typeof first !== "object") return {};
  const rec = first as Record<string, unknown>;
  const code = typeof rec.code === "string" ? rec.code : undefined;
  const raw = typeof rec.long_message === "string"
    ? rec.long_message
    : typeof rec.message === "string"
      ? rec.message
      : undefined;
  return { code, message: raw === undefined ? undefined : redact(raw, secrets).slice(0, 300) };
}

function indicatesDevBrowserRequired(body: Record<string, unknown> | null): boolean {
  if (!body || !Array.isArray(body.errors)) return false;
  return body.errors.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const rec = entry as Record<string, unknown>;
    return [rec.code, rec.message, rec.long_message].some(
      (v) => typeof v === "string" && DEV_BROWSER_HINT_RE.test(v),
    );
  });
}

/** Top-level field, or one level down under `response` (Clerk's envelope). */
function envelopeField(body: Record<string, unknown> | null, name: string): unknown {
  if (!body) return undefined;
  if (body[name] !== undefined) return body[name];
  const nested = body.response;
  return nested && typeof nested === "object"
    ? (nested as Record<string, unknown>)[name]
    : undefined;
}

function failure(
  stage: string,
  what: string,
  res: FapiResponse,
  secrets: string[],
): SetbuildAuthError {
  const { code, message } = clerkError(res.body, secrets);
  const detail = [code, message].filter(Boolean).join(": ");
  return new SetbuildAuthError(
    stage,
    `${what} (HTTP ${res.status}${detail ? `, ${detail}` : ""}).`,
    { status: res.status, code },
  );
}

/** True for a failure worth re-running the chain for. */
export function isTransient(err: unknown): boolean {
  return err instanceof SetbuildAuthError &&
    (err.status === undefined ? err.stage.endsWith("_unreachable") : TRANSIENT_STATUSES.has(err.status));
}

/**
 * Redeem a sign-in ticket and return the new session. Throws
 * `SetbuildAuthError` (stage `fapi_sign_in*` / `dev_browser*`) on any failure.
 */
export async function redeemTicket(ctx: FapiContext, ticket: string): Promise<FapiSession> {
  const secrets = secretsOf(ctx, [ticket]);
  const form = { strategy: "ticket", ticket };
  let devBrowserJwt: string | undefined;

  let res = await fapiPost(ctx, "/v1/client/sign_ins", { form, stage: "fapi_sign_in" });

  if (res.status >= 400 && indicatesDevBrowserRequired(res.body)) {
    const dev = await fapiPost(ctx, "/v1/dev_browser", { stage: "dev_browser" });
    if (dev.status < 200 || dev.status >= 300) {
      throw failure("dev_browser", "Clerk refused a dev-browser context", dev, secrets);
    }
    const token = envelopeField(dev.body, "token");
    if (typeof token !== "string" || token.length === 0) {
      throw new SetbuildAuthError(
        "dev_browser_unparseable",
        `Clerk's dev-browser answer carried no token (HTTP ${dev.status}).`,
        { status: dev.status },
      );
    }
    devBrowserJwt = token;
    res = await fapiPost(ctx, "/v1/client/sign_ins", {
      form,
      devBrowserJwt,
      stage: "fapi_sign_in",
    });
  }

  const allSecrets = [...secrets, ...(devBrowserJwt ? [devBrowserJwt] : [])];
  if (res.status < 200 || res.status >= 300) {
    throw failure("fapi_sign_in", "Clerk refused the sign-in ticket", res, allSecrets);
  }

  const status = envelopeField(res.body, "status");
  if (status !== undefined && status !== "complete") {
    throw new SetbuildAuthError(
      "fapi_sign_in_incomplete",
      `Clerk's sign-in did not complete (status "${String(status).slice(0, 40)}"); the test account may need a second factor.`,
      { status: res.status },
    );
  }
  const sessionId = envelopeField(res.body, "created_session_id");
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw new SetbuildAuthError(
      "fapi_sign_in_unparseable",
      `Clerk's sign-in answer carried no usable session id (HTTP ${res.status}).`,
      { status: res.status },
    );
  }
  const clientJwt = res.authorization?.trim();
  if (!clientJwt) {
    throw new SetbuildAuthError(
      "fapi_sign_in_no_client",
      "Clerk's sign-in answer carried no Authorization header; native mode was not honoured.",
      { status: res.status },
    );
  }
  return { sessionId, clientJwt, ...(devBrowserJwt ? { devBrowserJwt } : {}) };
}

/**
 * Mint a JWT from `template` for `session`. A 401/403/404 means the session or
 * client is gone; the caller re-runs the chain. Updates `session.clientJwt` in
 * place when Clerk rotates it.
 */
export async function mintTemplateToken(
  ctx: FapiContext,
  session: FapiSession,
  template: string = CONVEX_JWT_TEMPLATE,
): Promise<string> {
  if (!SESSION_ID_RE.test(session.sessionId) || !TEMPLATE_RE.test(template)) {
    throw new SetbuildAuthError("mint_input", "Refusing to mint: malformed session id or template name.");
  }
  const secrets = secretsOf(ctx, [session.clientJwt, session.devBrowserJwt]);
  const res = await fapiPost(
    ctx,
    `/v1/client/sessions/${session.sessionId}/tokens/${template}`,
    {
      authorization: session.clientJwt,
      devBrowserJwt: session.devBrowserJwt,
      stage: "fapi_mint",
    },
  );
  if (res.status < 200 || res.status >= 300) {
    throw failure("fapi_mint", `Clerk refused to mint a "${template}" token`, res, secrets);
  }
  const rotated = res.authorization?.trim();
  if (rotated) session.clientJwt = rotated;
  const jwt = envelopeField(res.body, "jwt");
  if (typeof jwt !== "string" || jwt.length === 0) {
    throw new SetbuildAuthError(
      "fapi_mint_unparseable",
      `Clerk's mint answer carried no jwt (HTTP ${res.status}).`,
      { status: res.status },
    );
  }
  return jwt;
}
