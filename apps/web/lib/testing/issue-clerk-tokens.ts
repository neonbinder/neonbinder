// Shared logic for minting Clerk sign-in + testing tokens so that Maestro
// E2E flows can bypass the password form and Clerk's bot detection.
//
// Used by:
// - Vite dev-server middleware (vite.config.ts) for local `vite dev`
// - Vercel serverless function (api/auth/testing.ts) for Vercel preview deploys
//
// Clerk Backend API is rate-limited and occasionally returns 5xx under
// burst load (3 parallel Maestro workers each hitting /v1/users +
// /v1/sign_in_tokens per flow). Without retries those transient failures
// surface as misleading "user not found" / "token creation failed"
// errors because the wrapper has no way to distinguish a 200 with empty
// data from a 429/5xx with an error body. We now retry transient failures
// and surface the real upstream status + truncated response body via
// IssueResult.detail so the audit log captures what Clerk actually said.

type ClerkStage = "users" | "sign_in_token" | "testing_token";

export interface ClerkErrorDetail {
  stage: ClerkStage;
  status: number;
  body: string;
}

export type IssueResult =
  | {
      ok: true;
      signInToken: string;
      testingToken: string | undefined;
      clerkUserId: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
      detail?: ClerkErrorDetail | { token?: unknown };
    };

export interface IssueEnv {
  clerkSecretKey: string | undefined;
  testEmail: string | undefined;
  /** Test hook: override delay between retry attempts. */
  sleep?: (attempt: number) => Promise<void>;
  /** Test hook: override fetch. */
  fetchFn?: typeof fetch;
}

// Backoff schedule (ms) between successive attempts. Index N is the wait
// before attempt N+2 (no wait before attempt 1). Total sleep budget across
// a single call ≈ 2.3 s before jitter; add per-attempt fetch round-trips
// for the real wall-clock — well within setup.yaml's 60 s
// extendedWaitUntil window.
const BACKOFF_MS = [200, 600, 1500];

// Status codes that indicate a transient Clerk failure worth retrying.
// 401/403/404 are intentionally excluded — those are deterministic auth /
// not-found errors and retrying just wastes the budget.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

const MAX_BODY_CHARS = 500;

function jitter(ms: number): number {
  // ±25% jitter to spread retries across concurrent workers and avoid
  // a thundering-herd that re-triggers the same rate-limit window.
  return ms * (0.75 + Math.random() * 0.5);
}

function defaultSleep(attempt: number): Promise<void> {
  const base = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
  return new Promise((resolve) => setTimeout(resolve, jitter(base)));
}

interface FetchSuccess {
  ok: true;
  status: number;
  body: unknown;
}

interface FetchFailure {
  ok: false;
  detail: ClerkErrorDetail;
}

async function fetchClerkWithRetry(
  url: string,
  init: RequestInit,
  stage: ClerkStage,
  sleep: (attempt: number) => Promise<void>,
  fetchFn: typeof fetch,
): Promise<FetchSuccess | FetchFailure> {
  const maxAttempts = BACKOFF_MS.length + 1;
  let lastDetail: ClerkErrorDetail = {
    stage,
    status: 0,
    body: "no attempts made",
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleep(attempt - 1);

    let res: Response;
    try {
      res = await fetchFn(url, init);
    } catch (err) {
      lastDetail = {
        stage,
        status: 0,
        body: `network error: ${(err as Error).message}`.slice(0, MAX_BODY_CHARS),
      };
      if (attempt === maxAttempts) break;
      continue;
    }

    // Read body exactly once, even on error, so detail.body is populated.
    const text = await res.text();

    if (res.ok) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { ok: true, status: res.status, body: parsed };
    }

    lastDetail = {
      stage,
      status: res.status,
      body: text.slice(0, MAX_BODY_CHARS),
    };
    if (!RETRYABLE_STATUSES.has(res.status)) break;
  }

  return { ok: false, detail: lastDetail };
}

export async function issueClerkTestingTokens(
  env: IssueEnv,
): Promise<IssueResult> {
  const { clerkSecretKey, testEmail } = env;
  const sleep = env.sleep ?? defaultSleep;
  const fetchFn = env.fetchFn ?? globalThis.fetch.bind(globalThis);

  if (!clerkSecretKey || !testEmail) {
    return {
      ok: false,
      status: 500,
      error: "CLERK_SECRET_KEY and TEST_EMAIL must be set",
    };
  }

  const usersResult = await fetchClerkWithRetry(
    `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(testEmail)}`,
    { headers: { Authorization: `Bearer ${clerkSecretKey}` } },
    "users",
    sleep,
    fetchFn,
  );
  if (!usersResult.ok) {
    return {
      ok: false,
      status: usersResult.detail.status || 502,
      error: "clerk_api_error",
      detail: usersResult.detail,
    };
  }

  // Clerk's /v1/users returns either a bare array (legacy) or `{ data: [] }`.
  const usersBody = usersResult.body;
  const users = Array.isArray(usersBody)
    ? usersBody
    : Array.isArray((usersBody as { data?: unknown }).data)
      ? (usersBody as { data: unknown[] }).data
      : null;
  if (users === null) {
    // 2xx with an unexpected shape — log it as a Clerk API anomaly so
    // we don't silently mistake it for "user not found".
    return {
      ok: false,
      status: 502,
      error: "clerk_api_error",
      detail: {
        stage: "users",
        status: usersResult.status,
        body: JSON.stringify(usersBody).slice(0, MAX_BODY_CHARS),
      },
    };
  }
  if (users.length === 0) {
    return {
      ok: false,
      status: 404,
      error: `No Clerk user found for ${testEmail}`,
    };
  }
  const userId = (users[0] as { id: string }).id;

  const [signInResult, testingResult] = await Promise.all([
    fetchClerkWithRetry(
      "https://api.clerk.com/v1/sign_in_tokens",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clerkSecretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: userId,
          expires_in_seconds: 120,
        }),
      },
      "sign_in_token",
      sleep,
      fetchFn,
    ),
    fetchClerkWithRetry(
      "https://api.clerk.com/v1/testing_tokens",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${clerkSecretKey}` },
      },
      "testing_token",
      sleep,
      fetchFn,
    ),
  ]);

  if (!signInResult.ok) {
    return {
      ok: false,
      status: signInResult.detail.status || 502,
      error: "clerk_api_error",
      detail: signInResult.detail,
    };
  }

  const signInBody = signInResult.body as { token?: string };
  if (!signInBody.token) {
    return {
      ok: false,
      status: 500,
      error: "Failed to create sign-in token",
      detail: { token: signInBody.token },
    };
  }

  // testing_tokens is best-effort: a missing token just degrades the
  // client to non-testing mode (Clerk bot-protection may then challenge).
  // Surface the failure shape in detail-on-success would break the type,
  // so we accept the loss here; api/auth/testing.ts already logs ok-false
  // calls and this one returned ok-true with testingToken=undefined.
  const testingToken = testingResult.ok
    ? (testingResult.body as { token?: string }).token
    : undefined;

  return {
    ok: true,
    signInToken: signInBody.token,
    testingToken,
    clerkUserId: userId,
  };
}
