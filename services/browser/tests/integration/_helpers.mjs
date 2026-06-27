/**
 * Shared helpers for the prod-gate integration suite.
 *
 * Each test file here exercises one capability of the browser service
 * against a deployed target (the Cloud Run tagged revision in CI, or
 * `http://localhost:8080` during local development). They talk to the
 * service over HTTP and exercise real marketplace round-trips — unlike
 * the per-adapter unit tests under `tests/*.test.mjs` which mock fetch.
 *
 * NEO-20: the browser service is IAM-gated by Cloud Run — app-layer
 * x-internal-key auth is gone (see src/index.ts). Authenticated requests
 * carry a Google OIDC ID token in `Authorization: Bearer`. Cloud Run
 * validates the token's audience against the *base* service URL even when
 * the request hits a tag-prefixed revision URL, so the minted token's
 * audience must be the base `*.run.app` service URL, not the tagged URL
 * this suite targets. The caller (CI workflow) mints that token and passes
 * it via PROBE_ID_TOKEN.
 *
 * Required env:
 *   TARGET_URL          — URL of the service/tagged revision (no trailing slash).
 *   PROBE_ID_TOKEN      — Google OIDC ID token (audience = base service URL).
 *                         Required only when TARGET_URL is a `*.run.app` host;
 *                         the local `http://localhost:8080` dev path needs no auth.
 *
 * Run locally (no auth needed against localhost):
 *   TARGET_URL=http://localhost:8080 \
 *   BSC_USERNAME=... BSC_PASSWORD=... \
 *   SPORTLOTS_USERNAME=... SPORTLOTS_PASSWORD=... \
 *   npm run test:prod-gate
 *
 * Run against a deployed (IAM-gated) service:
 *   BASE_URL=https://neonbinder-browser-xxxx-uc.a.run.app
 *   PROBE_ID_TOKEN=$(gcloud auth print-identity-token \
 *     --impersonate-service-account=neonbinder-browser-deployer@<project>.iam.gserviceaccount.com \
 *     --audiences="$BASE_URL")
 *   TARGET_URL="$BASE_URL" PROBE_ID_TOKEN=$PROBE_ID_TOKEN ... npm run test:prod-gate
 */

import assert from "node:assert/strict";

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var ${name}. See tests/integration/_helpers.mjs for the full list.`,
    );
  }
  return v;
}

export const TARGET_URL = requireEnv("TARGET_URL").replace(/\/$/, "");

// Cloud Run hosts require an OIDC token; localhost dev does not. Decide once.
const IS_CLOUD_RUN = /\.run\.app$/i.test(new URL(TARGET_URL).hostname);
const PROBE_ID_TOKEN = IS_CLOUD_RUN ? requireEnv("PROBE_ID_TOKEN") : undefined;

function authHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (PROBE_ID_TOKEN) {
    headers["Authorization"] = `Bearer ${PROBE_ID_TOKEN}`;
  }
  return headers;
}

/**
 * Build a unique credential key for this probe run. `slug` identifies the
 * marketplace (`bsc`, `sportlots`), `GITHUB_SHA` provides uniqueness when
 * running in CI; falls back to a timestamp locally so concurrent dev runs
 * don't collide.
 *
 * Key format matches `src/services/secrets-manager.ts`'s
 * KEY_PATTERN = /^[a-z0-9]+-credentials-[a-zA-Z0-9_-]+$/ — the literal
 * "-credentials-" segment is required or PUT /credentials/:key returns
 * HTTP 400 "Invalid credential key format".
 */
export function probeKey(slug) {
  const sha = (process.env.GITHUB_SHA || String(Date.now())).slice(0, 7);
  return `${slug}-credentials-probe-${sha}`;
}

export async function putCredentials(key, { username, password }) {
  const res = await fetch(`${TARGET_URL}/credentials/${key}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ username, password }),
  });
  const text = await res.text();
  assert.equal(
    res.status,
    200,
    `PUT /credentials/${key} returned ${res.status}: ${text}`,
  );
}

/**
 * Best-effort cleanup — never throws. Called from `after()` hooks via
 * wrappers that ignore errors so a cleanup failure can't mask the real
 * test failure.
 */
export async function deleteCredentials(key) {
  try {
    await fetch(`${TARGET_URL}/credentials/${key}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
  } catch (err) {
    // Log but don't rethrow — the test's real signal is its own
    // assertion, and a cleanup failure just leaves a SHA-scoped Secret
    // Manager entry that will age out anyway.
    console.warn(`cleanup of ${key} failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * POST /login/{slug} with a key referencing credentials already stored
 * via putCredentials. Returns `{ status, body }`. Marketplace login
 * calls can take 20-30 seconds (Puppeteer cold start + real SL/BSC
 * round-trip); the default timeout reflects that.
 */
export async function postLogin(slug, key, { timeoutMs = 90_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${TARGET_URL}/login/${slug}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ key }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { _rawText: text };
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Assertion helper used by every marketplace login test — same shape
 * each time so adding a new marketplace is a one-line `assertLoginOk`
 * call plus credential envs.
 */
export function assertLoginOk({ status, body }) {
  assert.equal(
    status,
    200,
    `login returned HTTP ${status}: ${JSON.stringify(body)}`,
  );
  assert.equal(
    body.success,
    true,
    `login body did not indicate success: ${JSON.stringify(body)}`,
  );
}
