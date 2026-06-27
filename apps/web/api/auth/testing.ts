import type { VercelRequest, VercelResponse } from "@vercel/node";
import { issueClerkTestingTokens } from "../../lib/testing/issue-clerk-tokens.js";

// POST /api/auth/testing — mints Clerk sign-in + testing tokens for E2E runs.
//
// Body: optional { account?: "main" | "new-profile", worker?: number }.
//   - account: "main" (default) or "new-profile"
//   - worker: integer index (0..N-1) used to pick a per-parallel-worker test
//     account so concurrent flows don't trample each other's user state.
//     When set, resolves TEST_EMAIL_${worker} / NEW_PROFILE_TEST_EMAIL_${worker};
//     falls back to unindexed TEST_EMAIL / NEW_PROFILE_TEST_EMAIL when the
//     indexed var isn't configured (single-worker / legacy setups).
//
// Security layers:
// 1. Vercel env-var scoping: CLERK_TESTING_ENABLED, TEST_EMAIL, CLERK_SECRET_KEY,
//    and TESTING_ENDPOINT_SECRET are set only on Preview + Development envs,
//    never Production. Without CLERK_SECRET_KEY, production cannot issue tokens.
// 2. Runtime VERCEL_ENV check — 404 if not preview/development.
// 3. Shared-secret header x-testing-auth must match TESTING_ENDPOINT_SECRET.
// 4. Email allowlist — only the requested account's *_EMAIL env var can be
//    used. Unknown account values are rejected.
// 5. 120s sign-in-token TTL (in issueClerkTestingTokens).
// 6. Logs each issuance for audit (includes which account was selected).

type TestAccount =
  | "main"
  | "new-profile"
  | "admin-no-credentials"
  | "admin-bsc-only"
  | "admin-sl-only";

const TEST_ACCOUNTS = [
  "main",
  "new-profile",
  "admin-no-credentials",
  "admin-bsc-only",
  "admin-sl-only",
] as const satisfies readonly TestAccount[];

// Closed enum → server-env mapping (Layer 4 of the gate). The email NEVER comes
// from the request — only from one of these env vars. The ADMIN_* accounts are
// the Set-Builder credential-gate fixtures; their *_TEST_EMAIL vars MUST be
// scoped to Vercel Preview + Development only — never Production.
const ACCOUNT_EMAIL_KEY: Record<TestAccount, string> = {
  "main": "TEST_EMAIL",
  "new-profile": "NEW_PROFILE_TEST_EMAIL",
  "admin-no-credentials": "ADMIN_NO_CREDENTIALS_TEST_EMAIL",
  "admin-bsc-only": "ADMIN_BSC_ONLY_TEST_EMAIL",
  "admin-sl-only": "ADMIN_SL_ONLY_TEST_EMAIL",
};
const MAX_WORKER_INDEX = 31;

function isTestAccount(value: unknown): value is TestAccount {
  return typeof value === "string" && (TEST_ACCOUNTS as readonly string[]).includes(value);
}

function parseWorkerIndex(value: unknown): { ok: true; index: number | null } | { ok: false } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, index: null };
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_WORKER_INDEX) {
    return { ok: false };
  }
  return { ok: true, index: n };
}

function resolveTestEmail(account: TestAccount, worker: number | null): string | undefined {
  const baseKey = ACCOUNT_EMAIL_KEY[account];
  if (worker !== null) {
    const indexed = process.env[`${baseKey}_${worker}`];
    if (indexed) return indexed;
  }
  return process.env[baseKey];
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Layer 2: hard 404 outside preview/development. Covers the case where
  // someone forgets to scope env vars and the endpoint ends up in prod.
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv && vercelEnv !== "preview" && vercelEnv !== "development") {
    res.status(404).json({ error: "Not found" });
    return;
  }

  // Layer 1: gate on explicit opt-in env var.
  if (process.env.CLERK_TESTING_ENABLED !== "true") {
    res.status(404).json({ error: "Not found" });
    return;
  }

  // Layer 3: shared-secret header. Without TESTING_ENDPOINT_SECRET set on
  // the server, no request can succeed (strict comparison with undefined).
  const expectedSecret = process.env.TESTING_ENDPOINT_SECRET;
  const providedSecret = req.headers["x-testing-auth"];
  if (!expectedSecret || providedSecret !== expectedSecret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Layer 4: account selector — restrict to the explicit allowlist of
  // known accounts; reject anything else. VercelRequest auto-parses JSON
  // bodies when Content-Type is application/json.
  const body = (req.body as { account?: unknown; worker?: unknown } | undefined) ?? {};
  const requestedAccount = body.account;
  const account: TestAccount = requestedAccount === undefined ? "main" : (
    isTestAccount(requestedAccount) ? requestedAccount : "main"
  );
  if (requestedAccount !== undefined && !isTestAccount(requestedAccount)) {
    res.status(400).json({ error: "Unknown account" });
    return;
  }
  const parsedWorker = parseWorkerIndex(body.worker);
  if (!parsedWorker.ok) {
    res.status(400).json({ error: "Invalid worker index" });
    return;
  }
  const worker = parsedWorker.index;
  const testEmail = resolveTestEmail(account, worker);
  if (!testEmail) {
    const baseKey = ACCOUNT_EMAIL_KEY[account];
    const detail = worker !== null ? ` (tried ${baseKey}_${worker} and ${baseKey})` : "";
    res.status(500).json({
      error: `${baseKey} not configured for account "${account}"${detail}`,
    });
    return;
  }

  const result = await issueClerkTestingTokens({
    clerkSecretKey: process.env.CLERK_SECRET_KEY,
    testEmail,
  });

  // Layer 6: audit log (visible in Vercel logs).
  const forwardedFor = req.headers["x-forwarded-for"];
  const ip = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : (forwardedFor ?? "unknown");
  const deploymentUrl = req.headers["x-vercel-deployment-url"] ?? "unknown";
  console.log(
    JSON.stringify({
      event: "testing_tokens_issued",
      ok: result.ok,
      ip,
      account,
      worker,
      email: testEmail,
      deploymentUrl,
      vercelEnv,
      ts: new Date().toISOString(),
      // Surface upstream Clerk failures into Vercel logs so we can tell
      // a real "user not found" apart from a 429/5xx that the wrapper
      // would otherwise mask. Server-side only — the response body below
      // intentionally omits `detail` because it may contain Clerk
      // internals that the test client shouldn't see.
      ...(result.ok ? {} : { detail: result.detail }),
    }),
  );

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  // Per-user state reset is done browser-side by the Maestro flow after
  // sign-in: it reads the per-PR Convex URL from window.__convexUrl, then
  // POSTs to /testing/reset-user-state on the Convex preview deployment.
  // The Vercel lambda can't do this itself — its process.env.VITE_CONVEX_URL
  // is the dev URL (from the Vercel dashboard), not the per-PR preview that
  // the client bundle actually talks to. clerkUserId is returned so the test
  // flow has the value to send as the reset body.
  res.status(200).json({
    signInToken: result.signInToken,
    testingToken: result.testingToken,
    clerkUserId: result.clerkUserId,
  });
}
