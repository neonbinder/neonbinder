// NEO-140 / NEO-141 (see the bottom half of this file):
//
// NEO-140 — `GET /credentials/:key/token` used to answer 404 for TWO unrelated
// things, separable only by the response body: "the secret exists but no token
// is cached" (a normal state) and "no such secret". `readCachedToken` read the
// status alone and collapsed both into `"not_found"`, so `getSiteToken` deleted
// live users' credential status while their secrets sat ENABLED in Secret
// Manager. `saveCredentials` triggered it on itself: its `PUT /credentials`
// wiped the cached token, so the next token read 404'd and wiped the
// `hasCredentials: true` the save had just written.
//
// NEO-141 — we no longer store passwords at all. Saving is connect-and-store:
// the password goes to the login route transiently and only the resulting
// session is persisted. So a save either fully succeeds or fully fails, and a
// session that can't be renewed is FLAGGED (`needsReauth`) rather than deleted.
//
// Unit tests for NEO-89: the atomic saveCredentials action (replacing the
// old two-step storeSiteCredentials + client-triggered updateSiteCredentialStatus
// pair) and getSiteToken's self-healing of a stale hasCredentials flag when
// the underlying secret is discovered missing.
//
// Root-cause context (see NEO-89): a credential "delete" used to be two
// separate network calls — the browser-service secret delete, then a SEPARATE
// client-triggered Convex mutation to clear `hasCredentials`. If the client
// was interrupted between the two, Convex kept believing credentials existed
// after the secret was actually gone — a permanent "ghost credentials" state.
// These tests assert the fix: the Convex flag write now happens server-side,
// inside the same action as the secret write, and getSiteToken self-heals any
// pre-existing drift it discovers.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { __resetContractCache } from "./credentials";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER_A = "user_cred_aaaa1111";
const SITE = "buysportscards";

type FetchStub = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * NEO-143: every authenticated browser-service call now pre-flights
 * `GET /health` to read the service's contract version, so a Convex build can
 * never speak a request shape the live service predates.
 *
 * These tests assert on the CREDENTIAL calls, so serve the probe centrally and
 * keep it out of each test's recorded call list. Tests that exercise the guard
 * itself stub `/health` directly — see the "contract guard" block at the end of
 * this file.
 */
function stubFetch(handler: FetchStub) {
  vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/health")) {
      return jsonResponse({
        status: "ok",
        environment: "test",
        contractVersion: REQUIRED_CONTRACT_VERSION_FOR_TESTS,
      });
    }
    return handler(url, init);
  }) as FetchStub);
}

/**
 * Mirrors REQUIRED_CONTRACT_VERSION in credentials.ts. Kept as a separate
 * literal on purpose: if someone raises the requirement without shipping a
 * service that advertises it, these tests should start failing.
 */
const REQUIRED_CONTRACT_VERSION_FOR_TESTS = 1;

async function getRawEntry(t: ReturnType<typeof convexTest>, userId: string, site: string) {
  return t.run(async (ctx) => {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return profile?.siteCredentials?.find((c) => c.site === site) ?? null;
  });
}

async function seedHasCredentials(
  t: ReturnType<typeof convexTest>,
  userId: string,
  site: string,
  lastUpdated = "2020-01-01T00:00:00.000Z",
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("userProfiles", {
      userId,
      siteCredentials: [{ site, hasCredentials: true, lastUpdated }],
    });
  });
}

/** Seed a LIVE (non-expired) credential lock, simulating an in-flight store. */
async function seedLiveLock(
  t: ReturnType<typeof convexTest>,
  userId: string,
  site: string,
  lockToken = "tok-inflight-store",
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("userProfiles", {
      userId,
      siteCredentials: [
        {
          site,
          hasCredentials: false,
          lockedAt: Date.now(),
          lockedOp: "store",
          lockToken,
        },
      ],
    });
  });
}

beforeEach(() => {
  // Loopback browser URL → getIdTokenClient short-circuits (no OIDC / no GCP creds).
  process.env.NEONBINDER_BROWSER_URL = "http://localhost:9999";
  // NEO-143: the contract probe is cached at module scope for 60s. Without this
  // reset the first test's probe would satisfy every later test, so a test that
  // deliberately serves an OLD /health would silently pass against a stale
  // "healthy" cache entry — the exact false-green the guard exists to prevent.
  __resetContractCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEONBINDER_BROWSER_URL;
});

describe("saveCredentials — store branch (connect-and-store, NEO-141)", () => {
  test("logs in with the transient password, stores no password, sets hasCredentials:true", async () => {
    const t = convexTest(schema, modules);
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const stub: FetchStub = async (url, init) => {
      const u = String(url);
      calls.push({
        url: u,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (u.includes("/login/bsc")) return jsonResponse({ success: true, message: "ok" });
      throw new Error(`unexpected fetch: ${init?.method} ${u}`);
    };
    stubFetch(stub);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, {
        site: SITE,
        username: "real-user",
        password: "real-pass",
      });

    expect(result.success).toBe(true);
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry?.hasCredentials).toBe(true);

    // The ONLY browser-service call is the login. NEO-141 deleted the old
    // `PUT /credentials` write — that PUT persisted the password AND wiped any
    // cached token, which is what made saveCredentials trigger NEO-140.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/login/bsc");
    expect(calls[0].body).toEqual({
      key: expect.stringContaining(`${SITE}-credentials-`),
      username: "real-user",
      password: "real-pass",
    });
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("a successful save clears a pre-existing needsReauth flag", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: USER_A,
        siteCredentials: [
          {
            site: SITE,
            hasCredentials: true,
            needsReauth: true,
            needsReauthSince: 1_700_000_000_000,
          },
        ],
      });
    });

    const stub: FetchStub = async (url) =>
      String(url).includes("/login/bsc")
        ? jsonResponse({ success: true, message: "ok" })
        : (() => {
            throw new Error(`unexpected fetch: ${url}`);
          })();
    stubFetch(stub);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, {
        site: SITE,
        username: "real-user",
        password: "real-pass",
      });

    expect(result.success).toBe(true);
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry?.hasCredentials).toBe(true);
    expect(entry?.needsReauth).toBeFalsy();
    expect(entry?.needsReauthSince).toBeUndefined();
  });

  test("a failed login stores NOTHING — no credentials, no needsReauth flag", async () => {
    const t = convexTest(schema, modules);
    // A rejected password as the service actually answers it (NEO-98: 422 +
    // a forced class). NEO-281 reads an UNclassified failure as "the
    // marketplace didn't answer", so a bare body here would test the wrong copy.
    const stub: FetchStub = async () =>
      jsonResponse({ error: "Invalid credentials", error_class: "invalid_credentials" }, 422);
    stubFetch(stub);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, {
        site: SITE,
        username: "real-user",
        password: "real-pass",
      });

    expect(result.success).toBe(false);
    // NEO-141: saving is now all-or-nothing. There is no "credentials were
    // saved, but authentication failed" middle state to leave behind.
    expect(result.message).toMatch(/nothing was saved/i);
    // acquireCredentialLock creates the row on first touch (hasCredentials
    // defaults false) even though the store itself failed — the row existing
    // is fine; what matters is it does NOT claim credentials were saved.
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry?.hasCredentials).toBeFalsy();
    expect(entry?.needsReauth).toBeFalsy();
  });

  test("rejects mismatched username/password (one provided, other blank) without any network call", async () => {
    const t = convexTest(schema, modules);
    const stub: FetchStub = async (url) => {
      throw new Error(`should not have called fetch: ${String(url)}`);
    };
    stubFetch(stub);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, {
        site: SITE,
        username: "only-username",
      });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/both username and password|neither/i);
  });
});

describe("saveCredentials — clear branch (atomic flag update, replaces deleteSiteCredentials)", () => {
  test("successful DELETE clears hasCredentials server-side, no second call needed", async () => {
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, SITE);

    const stub: FetchStub = async (url, init) => {
      const u = String(url);
      if (u.includes("/credentials/") && init?.method === "DELETE") {
        return jsonResponse({ success: true });
      }
      throw new Error(`unexpected fetch: ${init?.method} ${u}`);
    };
    stubFetch(stub);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, { site: SITE });

    expect(result.success).toBe(true);
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry).toBeNull();
  });

  test("failed DELETE leaves hasCredentials untouched — this is the exact NEO-89 gap closed", async () => {
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, SITE);

    const stub: FetchStub = async () => jsonResponse({ error: "server error" }, 500);
    stubFetch(stub);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, { site: SITE });

    expect(result.success).toBe(false);
    // The flag must still say true — the secret was never actually deleted,
    // so believing otherwise would be the OPPOSITE bug (false ghost-absence).
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry?.hasCredentials).toBe(true);
  });
});

describe("saveCredentials — rejects unsupported sites without any network call", () => {
  test("returns an error and never calls fetch for an unknown site", async () => {
    const t = convexTest(schema, modules);
    const stub: FetchStub = async (url) => {
      throw new Error(`should not have called fetch: ${String(url)}`);
    };
    stubFetch(stub);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, {
        site: "some-made-up-site",
        username: "u",
        password: "p",
      });

    expect(result).toEqual({ success: false, message: "Unsupported site: some-made-up-site" });
  });
});

describe("getSiteToken — self-heal is lock-aware (security review finding, NEO-89)", () => {
  test("does NOT self-heal (or touch the lock) while a store is actively holding the lock", async () => {
    const t = convexTest(schema, modules);
    await seedLiveLock(t, USER_A, SITE, "tok-inflight-store");

    const stub: FetchStub = async (url) => {
      const u = String(url);
      // The literal body the browser service returns for a genuine absence.
      // Self-heal requires a positive match on it, so the fixture must be the
      // real string rather than an approximation of it.
      if (u.includes("/token")) {
        return jsonResponse({ error: "Credentials not found" }, 404);
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    stubFetch(stub);

    const token = await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });

    expect(token).toBeNull();
    // The in-flight store's lock entry must survive untouched — self-heal
    // must not clobber it.
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry?.lockToken).toBe("tok-inflight-store");
    expect(entry?.lockedOp).toBe("store");
  });

  test("DOES self-heal once the lock has expired (stale lock is not a false positive)", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: USER_A,
        siteCredentials: [
          {
            site: SITE,
            hasCredentials: true,
            // Well past CRED_LOCK_LEASE_MS (5 min) — a crashed/abandoned op.
            lockedAt: Date.now() - 10 * 60 * 1000,
            lockedOp: "store",
            lockToken: "tok-abandoned",
          },
        ],
      });
    });

    const stub: FetchStub = async (url) => {
      const u = String(url);
      // The literal body the browser service returns for a genuine absence.
      // Self-heal requires a positive match on it, so the fixture must be the
      // real string rather than an approximation of it.
      if (u.includes("/token")) {
        return jsonResponse({ error: "Credentials not found" }, 404);
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    stubFetch(stub);

    const token = await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });

    expect(token).toBeNull();
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry).toBeNull();
  });
});

describe("getSiteToken — self-heals a stale hasCredentials flag (NEO-89)", () => {
  test("clears hasCredentials and returns null when the secret is genuinely missing (404)", async () => {
    const t = convexTest(schema, modules);
    // Simulate the exact incident: Convex believes credentials exist, but the
    // underlying GCP secret was deleted out from under it.
    await seedHasCredentials(t, USER_A, SITE);

    const stub: FetchStub = async (url) => {
      const u = String(url);
      // The genuine-absence body, per the browser service's contract.
      if (u.includes("/token")) return jsonResponse({ error: "Credentials not found" }, 404);
      throw new Error(`unexpected fetch: ${u}`);
    };
    stubFetch(stub);

    const token = await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });

    expect(token).toBeNull();
    const entry = await getRawEntry(t, USER_A, SITE);
    // Self-healed: the stale flag is gone, matching reality.
    expect(entry).toBeNull();
  });

  test("does NOT touch hasCredentials on a transient (non-404) failure", async () => {
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, SITE);

    const stub: FetchStub = async (url) => {
      const u = String(url);
      if (u.includes("/token")) return jsonResponse({ error: "server error" }, 500);
      // refreshSiteToken → authenticateBsc → /login/bsc; let it fail too so
      // getSiteToken falls through to null without a self-heal (correct: a
      // transient 500 is not proof the secret is missing).
      if (u.includes("/login/")) return jsonResponse({ success: false, message: "down" }, 500);
      throw new Error(`unexpected fetch: ${u}`);
    };
    stubFetch(stub);

    const token = await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });

    expect(token).toBeNull();
    // NOT self-healed — a transient failure is not evidence the secret is gone.
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry?.hasCredentials).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NEO-140 — "no token cached" must never be mistaken for "no credentials".
//
// These are the regression tests for the destructive bug: a perfectly healthy
// account whose cached token had simply expired (or had never been minted) got
// its credential status DELETED, dropping the user back to a blank
// "enter your credentials" form with no recovery but re-typing their password.
// ---------------------------------------------------------------------------

/**
 * Stub the token read with a given response, and answer the follow-up login
 * attempt with `loginResponse`. Records whether a login was attempted.
 */
function tokenAndLoginStub(
  tokenResponse: () => Response,
  loginResponse: () => Response,
  seen: { loginAttempts: number },
): FetchStub {
  return async (url) => {
    const u = String(url);
    if (u.includes("/token")) return tokenResponse();
    if (u.includes("/login/")) {
      seen.loginAttempts += 1;
      return loginResponse();
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
}

describe("getSiteToken — 204 means 'secret exists, nothing cached' (NEO-140)", () => {
  test("204 does NOT delete credential status, and DOES try to mint a token", async () => {
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, SITE);
    const seen = { loginAttempts: 0 };
    stubFetch(
      tokenAndLoginStub(
        () => new Response(null, { status: 204 }),
        () => jsonResponse({ success: false, message: "marketplace down" }, 500),
        seen,
      ),
    );

    const token = await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });

    expect(token).toBeNull();
    // The credential status survives — this is the whole ticket.
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry).not.toBeNull();
    expect(entry?.hasCredentials).toBe(true);
    // And we took the mint path rather than giving up. Before NEO-140 this
    // branch was unreachable: the benign case arrived as a 404 and was
    // collapsed into "not_found", so it took the destructive branch instead.
    expect(seen.loginAttempts).toBe(1);
  });

  test("204 then a successful mint returns the freshly minted token", async () => {
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, SITE);

    let minted = false;
    const stub: FetchStub = async (url) => {
      const u = String(url);
      if (u.includes("/token")) {
        return minted
          ? jsonResponse({ token: "tok-fresh", expiresAt: Date.now() + 3_600_000 })
          : new Response(null, { status: 204 });
      }
      if (u.includes("/login/")) {
        minted = true;
        return jsonResponse({ success: true, message: "ok" });
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    stubFetch(stub);

    const token = await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });

    expect(token?.token).toBe("tok-fresh");
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry?.hasCredentials).toBe(true);
  });
});

describe("getSiteToken — legacy 404 'No token available' is NOT absence (NEO-140)", () => {
  test("does NOT delete credential status on the deploy-skew 404 body", async () => {
    // Convex/Vercel and Cloud Run deploy independently, so "new Convex + old
    // browser service" is a real rollout window. In it, the benign case still
    // arrives as a bare 404 with this body. Reading the body is therefore a
    // PERMANENT requirement, not a temporary shim.
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, SITE);
    const seen = { loginAttempts: 0 };
    stubFetch(
      tokenAndLoginStub(
        () => jsonResponse({ error: "No token available" }, 404),
        () => jsonResponse({ success: false, message: "marketplace down" }, 500),
        seen,
      ),
    );

    const token = await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });

    expect(token).toBeNull();
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry).not.toBeNull();
    expect(entry?.hasCredentials).toBe(true);
    expect(seen.loginAttempts).toBe(1);
  });

  test("an UNPARSEABLE 404 body must NOT delete — ambiguity is not evidence", async () => {
    // An HTML 404 is what an intermediary returns, not what the browser
    // service returns: a Cloud Run error page, a load balancer, or a request
    // that landed on a revision predating this route. None of those are
    // evidence that the secret is gone.
    //
    // Self-heal therefore requires a POSITIVE match on the genuine-absence
    // body. The asymmetry is the whole lesson of NEO-140: destroying a live
    // credential is unrecoverable without the user re-typing their password,
    // whereas a stale flag surviving one extra call costs nothing and is
    // healed by the next genuine absence.
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, SITE);
    const seen = { loginAttempts: 0 };
    stubFetch(
      tokenAndLoginStub(
        () =>
          new Response("<html>gateway error</html>", {
            status: 404,
            headers: { "Content-Type": "text/html" },
          }),
        () => jsonResponse({ success: false, message: "marketplace down" }, 500),
        seen,
      ),
    );

    const token = await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });

    expect(token).toBeNull();
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry).not.toBeNull();
    expect(entry?.hasCredentials).toBe(true);
  });

  test("does NOT delete when a concurrent store lands between the read and the lock check", async () => {
    // The TOCTOU the confirm-read closes. Sequence: a store holds the lock, we
    // read the secret mid-write and get a genuine-absence 404, then the store
    // finishes, sets hasCredentials and RELEASES — so the lock check reads
    // "unlocked" and, on a single observation, we would delete the flag that
    // store just wrote. Nothing re-asserts it, so the loss is total.
    //
    // Modelled by a stub whose FIRST /token read 404s and whose second reflects
    // the completed store.
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, SITE);
    let tokenReads = 0;
    stubFetch((async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/token")) {
        tokenReads += 1;
        return tokenReads === 1
          ? jsonResponse({ error: "Credentials not found" }, 404)
          : jsonResponse({ token: "tok-from-completed-store", expiresAt: 1_900_000_000_000 }, 200);
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as FetchStub);

    await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });

    expect(tokenReads).toBeGreaterThanOrEqual(2); // the confirm-read happened
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry).not.toBeNull();
    expect(entry?.hasCredentials).toBe(true);
  });

  test("a well-formed 'Credentials not found' 404 DOES still heal (NEO-89)", async () => {
    // The positive match must keep working, or this change would trade one bug
    // for another by disabling the self-heal entirely.
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, SITE);
    stubFetch((async (url: string | URL | Request) => {
      if (String(url).includes("/token")) {
        return jsonResponse({ error: "Credentials not found" }, 404);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as FetchStub);

    const token = await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });

    expect(token).toBeNull();
    expect(await getRawEntry(t, USER_A, SITE)).toBeNull();
  });
});

describe("reauth_required — flag, never delete (NEO-141)", () => {
  test("a reauth_required login failure sets needsReauth and keeps the credentials", async () => {
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, SITE);
    const seen = { loginAttempts: 0 };
    stubFetch(
      tokenAndLoginStub(
        () => new Response(null, { status: 204 }),
        () =>
          jsonResponse(
            { error: "Authentication failed", error_class: "reauth_required" },
            // The browser service answers 422 here — its own error class, not a
            // marketplace outage, so it never pages.
            422,
          ),
        seen,
      ),
    );

    const token = await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });

    expect(token).toBeNull();
    const entry = await getRawEntry(t, USER_A, SITE);
    // NOT deleted: the secret (and the username in it) is still there. Only
    // the session died, and since NEO-141 there is no stored password to renew
    // it with — so the user is asked to sign in again, not to start over.
    expect(entry).not.toBeNull();
    expect(entry?.hasCredentials).toBe(true);
    expect(entry?.needsReauth).toBe(true);
    expect(typeof entry?.needsReauthSince).toBe("number");
  });

  test("testSiteCredentials surfaces reauth_required as a failure and flags it", async () => {
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, SITE);
    stubFetch((async (url: string | URL | Request) => {
      if (String(url).includes("/login/")) {
        return jsonResponse(
          { error: "Authentication failed", error_class: "reauth_required" },
          422,
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as FetchStub);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.testSiteCredentials, { site: SITE });

    expect(result.success).toBe(false);
    // NEO-281 left this copy alone: the marketplace DID answer here.
    expect(result.message).toBe(
      "BSC login failed. Please check your credentials and try again.",
    );
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry?.hasCredentials).toBe(true);
    expect(entry?.needsReauth).toBe(true);
  });

  test("needsReauth survives an unrelated credential op (lock acquire/release)", async () => {
    // acquireCredentialLock and releaseCredentialLock both REBUILD the entry
    // field-by-field, so anything not explicitly carried across is dropped. A
    // re-auth prompt that vanishes the next time anything touches the site
    // would be as bad as deleting it.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: USER_A,
        siteCredentials: [
          {
            site: SITE,
            hasCredentials: true,
            needsReauth: true,
            needsReauthSince: 1_700_000_000_000,
            reauthObservedAt: 1_700_000_500_000,
          },
        ],
      });
    });

    stubFetch((async (url: string | URL | Request) => {
      if (String(url).includes("/login/")) {
        return jsonResponse({ error: "still broken" }, 500);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as FetchStub);

    await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.testSiteCredentials, { site: SITE });

    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry?.needsReauth).toBe(true);
    // First-detected, not last-seen.
    expect(entry?.needsReauthSince).toBe(1_700_000_000_000);
    // NEO-278: the backoff stamp rides along too (a plain 500 is not a
    // reauth_required observation, so it must not be refreshed either).
    expect(entry?.reauthObservedAt).toBe(1_700_000_500_000);
    // Lock fully released.
    expect(entry?.lockToken).toBeUndefined();
    expect(entry?.lockedAt).toBeUndefined();
  });
});

// NEO-281: the browser service answers a stored-session validation that
// SportLots never responded to (5xx / 429 / timeout on every probe) as a 502
// with `error_class: "other"` and no re-auth signal; a timed-out exchange as
// `timeout`; and a request that never got a classified answer (fetch threw,
// 503-busy exhausted) carries no class at all. `applyLoginOutcome` was already
// right to write nothing for all of them — but the copy still read "check your
// credentials", telling the user it was their fault when the marketplace
// simply did not answer. These pin the message per error class.
describe("transient marketplace failure — never blame the user (NEO-281)", () => {
  const SL_TRANSIENT_502 = {
    error: "SportLots did not respond while validating the stored session; try again",
    error_class: "other",
  };

  /** Only the login route answers; anything else is a test bug. */
  function loginOnly(body: unknown, status: number): FetchStub {
    return (async (url: string | URL | Request) => {
      if (String(url).includes("/login/")) return jsonResponse(body, status);
      throw new Error(`unexpected fetch: ${url}`);
    }) as FetchStub;
  }

  test("Test credentials on a 502 `other` says SportLots didn't answer and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const lastUpdated = "2020-01-01T00:00:00.000Z";
    await seedHasCredentials(t, USER_A, "sportlots", lastUpdated);
    stubFetch(loginOnly(SL_TRANSIENT_502, 502));

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.testSiteCredentials, { site: "sportlots" });

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      "SportLots didn't answer. Nothing changed — try again in a minute.",
    );
    // No credential-status write of any kind: not a flag, not a timestamp.
    const entry = await getRawEntry(t, USER_A, "sportlots");
    expect(entry?.hasCredentials).toBe(true);
    expect(entry?.needsReauth).toBeFalsy();
    expect(entry?.needsReauthSince).toBeUndefined();
    expect(entry?.lastUpdated).toBe(lastUpdated);
  });

  test("the transient copy is per site: BSC gets its own", async () => {
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, SITE);
    stubFetch(loginOnly({ error: "Authentication failed", error_class: "other" }, 502));

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.testSiteCredentials, { site: SITE });

    expect(result.success).toBe(false);
    expect(result.message).toBe("BSC didn't answer. Nothing changed — try again in a minute.");
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry?.hasCredentials).toBe(true);
    expect(entry?.needsReauth).toBeFalsy();
  });

  test("a 422 reauth_required is unchanged: credentials copy, needsReauth flagged", async () => {
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, "sportlots");
    stubFetch(
      loginOnly({ error: "Re-authentication required", error_class: "reauth_required" }, 422),
    );

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.testSiteCredentials, { site: "sportlots" });

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      "SportLots login failed. Please check your credentials and try again.",
    );
    const entry = await getRawEntry(t, USER_A, "sportlots");
    expect(entry?.hasCredentials).toBe(true);
    expect(entry?.needsReauth).toBe(true);
    expect(typeof entry?.needsReauthSince).toBe("number");
  });

  test("a 422 invalid_credentials is unchanged: credentials copy, no flag", async () => {
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, "sportlots");
    stubFetch(
      loginOnly({ error: "Invalid credentials", error_class: "invalid_credentials" }, 422),
    );

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.testSiteCredentials, { site: "sportlots" });

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      "SportLots login failed. Please check your credentials and try again.",
    );
    const entry = await getRawEntry(t, USER_A, "sportlots");
    expect(entry?.hasCredentials).toBe(true);
    expect(entry?.needsReauth).toBeFalsy();
  });

  test("a 502 `timeout` is transient too: the exchange timed out, the user did nothing wrong", async () => {
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, "sportlots");
    stubFetch(loginOnly({ error: "Navigation timed out", error_class: "timeout" }, 502));

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.testSiteCredentials, { site: "sportlots" });

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      "SportLots didn't answer. Nothing changed — try again in a minute.",
    );
    const entry = await getRawEntry(t, USER_A, "sportlots");
    expect(entry?.hasCredentials).toBe(true);
    expect(entry?.needsReauth).toBeFalsy();
  });

  test("no error_class at all (the request to the browser service threw) is transient", async () => {
    // The Convex-side fetch failing — network, or our 60s abort — never
    // reaches the marketplace's verdict. Same bucket as the 503-busy
    // exhaustion: errorClass is undefined because nothing classified it.
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, "sportlots");
    stubFetch((async (url: string | URL | Request) => {
      if (String(url).includes("/login/")) throw new TypeError("fetch failed");
      throw new Error(`unexpected fetch: ${url}`);
    }) as FetchStub);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.testSiteCredentials, { site: "sportlots" });

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      "SportLots didn't answer. Nothing changed — try again in a minute.",
    );
    const entry = await getRawEntry(t, USER_A, "sportlots");
    expect(entry?.hasCredentials).toBe(true);
    expect(entry?.needsReauth).toBeFalsy();
  });

  test("a named non-transient class (oom) keeps the existing copy", async () => {
    // Scope guard: transient is exactly `other` / `timeout` / unclassified,
    // and site-side (NEO-288) is exactly `challenge` / `automated_access`.
    // Any other named class is a verdict of its own and keeps the old copy;
    // widening further is a deliberate decision, not a drift. (This case used
    // `challenge` until NEO-288 moved it to the site-side bucket below.)
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, "sportlots");
    stubFetch(loginOnly({ error: "Browser out of memory", error_class: "oom" }, 502));

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.testSiteCredentials, { site: "sportlots" });

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      "SportLots login failed. Please check your credentials and try again.",
    );
  });

  test("saveCredentials on a 502 `other` says the marketplace didn't answer, not 'check your password'", async () => {
    // Connect-and-store hands the typed password to the login route. If
    // SportLots 5xx's mid-login, the user's password is unproven, not wrong.
    const t = convexTest(schema, modules);
    stubFetch(loginOnly(SL_TRANSIENT_502, 502));

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, {
        site: "sportlots",
        username: "real-user",
        password: "real-pass",
      });

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      "SportLots didn't answer. Nothing changed — try again in a minute.",
    );
    expect(result.message).not.toMatch(/password/i);
    const entry = await getRawEntry(t, USER_A, "sportlots");
    expect(entry?.hasCredentials).toBeFalsy();
    expect(entry?.needsReauth).toBeFalsy();
  });
});

// NEO-288: the browser service is gaining a SportLots automated-access
// handshake. Two `error_class` values from `/login/sportlots` (and
// `/login/bsc`) mean "the marketplace turned US away": `challenge` (SportLots'
// refusal bodies for automated sign-ins now classify here) and the new
// `automated_access` (our owner-issued key was refused or is missing; 502).
// Neither says anything about the user's password, yet both used to fall
// through to "check your credentials". These pin the per-site site-side copy,
// the untouched credential status, and the `credential_test_failed` record
// that still carries the class for the NEO-43 alerting.
describe("site-side refusal — the marketplace turned us away, not the user (NEO-288)", () => {
  const SL_SITE_MESSAGE =
    "SportLots wouldn't let us in the door — that's on them, not your password. Nothing changed on your end. Give it another go in a bit.";
  const BSC_SITE_MESSAGE =
    "BSC wouldn't let us in the door — that's on them, not your password. Nothing changed on your end. Give it another go in a bit.";

  /** Only the login route answers; anything else is a test bug. */
  function loginOnly(body: unknown, status: number): FetchStub {
    return (async (url: string | URL | Request) => {
      if (String(url).includes("/login/")) return jsonResponse(body, status);
      throw new Error(`unexpected fetch: ${url}`);
    }) as FetchStub;
  }

  /**
   * `recordCredentialTest` writes one structured `credential_login_call`
   * console line per outcome before the PostHog capture (which no-ops in this
   * file — no POSTHOG_API_KEY; the capture itself is pinned in
   * credentials.instrumentation.test.ts). The line carries the same
   * `error_class`, so it is the observable record here.
   */
  function recordedFailures(spy: ReturnType<typeof vi.spyOn>) {
    return spy.mock.calls
      .map((call) => call[0])
      .filter((line): line is string => typeof line === "string" && line.startsWith("{"))
      .map((line) => JSON.parse(line) as { msg?: string; success?: boolean; error_class?: string; platform?: string })
      .filter((rec) => rec.msg === "credential_login_call" && rec.success === false);
  }

  for (const errorClass of ["challenge", "automated_access"] as const) {
    test(`Test credentials on a 502 \`${errorClass}\` says SportLots wouldn't let us in and writes nothing`, async () => {
      const t = convexTest(schema, modules);
      const lastUpdated = "2020-01-01T00:00:00.000Z";
      await seedHasCredentials(t, USER_A, "sportlots", lastUpdated);
      stubFetch(loginOnly({ error: "SportLots refused the sign-in", error_class: errorClass }, 502));
      const logSpy = vi.spyOn(console, "log");

      const result = await t
        .withIdentity({ subject: USER_A })
        .action(api.credentials.testSiteCredentials, { site: "sportlots" });

      expect(result.success).toBe(false);
      expect(result.message).toBe(SL_SITE_MESSAGE);
      expect(result.message).not.toMatch(/check your credentials/i);
      // No credential-status write of any kind: not a flag, not a timestamp.
      const entry = await getRawEntry(t, USER_A, "sportlots");
      expect(entry?.hasCredentials).toBe(true);
      expect(entry?.needsReauth).toBeFalsy();
      expect(entry?.needsReauthSince).toBeUndefined();
      expect(entry?.lastUpdated).toBe(lastUpdated);
      // Exactly one failure record, still tagged with the service's class —
      // the NEO-43 alerting must keep seeing site-side refusals.
      const failures = recordedFailures(logSpy);
      expect(failures).toHaveLength(1);
      expect(failures[0].platform).toBe("sportlots");
      expect(failures[0].error_class).toBe(errorClass);
      logSpy.mockRestore();
    });

    test(`saveCredentials on a 502 \`${errorClass}\` says SportLots wouldn't let us in, not 'check your password'`, async () => {
      // Connect-and-store hands the typed password to the login route. If
      // SportLots refuses the request before evaluating it, the password is
      // unproven, not wrong — and nothing may be stored either way.
      const t = convexTest(schema, modules);
      stubFetch(loginOnly({ error: "SportLots refused the sign-in", error_class: errorClass }, 502));
      const logSpy = vi.spyOn(console, "log");

      const result = await t
        .withIdentity({ subject: USER_A })
        .action(api.credentials.saveCredentials, {
          site: "sportlots",
          username: "real-user",
          password: "real-pass",
        });

      expect(result.success).toBe(false);
      // Verbatim: saveCredentials must not rewrite it into its own
      // "check your username and password" copy.
      expect(result.message).toBe(SL_SITE_MESSAGE);
      expect(result.message).not.toMatch(/check your/i);
      const entry = await getRawEntry(t, USER_A, "sportlots");
      expect(entry?.hasCredentials).toBeFalsy();
      expect(entry?.needsReauth).toBeFalsy();
      const failures = recordedFailures(logSpy);
      expect(failures).toHaveLength(1);
      expect(failures[0].error_class).toBe(errorClass);
      logSpy.mockRestore();
    });
  }

  test("a site-side refusal leaves a pre-existing needsReauth flag exactly as it was", async () => {
    // The flag is the user's to clear by signing in again; a refusal that
    // never evaluated their password is no evidence either way.
    const t = convexTest(schema, modules);
    const since = Date.now() - 60 * 60 * 1000;
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: USER_A,
        siteCredentials: [
          { site: "sportlots", hasCredentials: true, needsReauth: true, needsReauthSince: since },
        ],
      });
    });
    stubFetch(loginOnly({ error: "refused", error_class: "automated_access" }, 502));

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.testSiteCredentials, { site: "sportlots" });

    expect(result.success).toBe(false);
    expect(result.message).toBe(SL_SITE_MESSAGE);
    const entry = await getRawEntry(t, USER_A, "sportlots");
    expect(entry?.hasCredentials).toBe(true);
    expect(entry?.needsReauth).toBe(true);
    expect(entry?.needsReauthSince).toBe(since);
  });

  test("the site-side copy is per site: BSC `challenge` gets its own", async () => {
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, SITE);
    stubFetch(loginOnly({ error: "Authentication failed", error_class: "challenge" }, 500));

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.testSiteCredentials, { site: SITE });

    expect(result.success).toBe(false);
    expect(result.message).toBe(BSC_SITE_MESSAGE);
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry?.hasCredentials).toBe(true);
    expect(entry?.needsReauth).toBeFalsy();
  });

  test("regression guard: a 422 invalid_credentials still points the user at their credentials", async () => {
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, "sportlots");
    stubFetch(
      loginOnly({ error: "Invalid credentials", error_class: "invalid_credentials" }, 422),
    );

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.testSiteCredentials, { site: "sportlots" });

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      "SportLots login failed. Please check your credentials and try again.",
    );
    expect(result.message).not.toBe(SL_SITE_MESSAGE);
    const entry = await getRawEntry(t, USER_A, "sportlots");
    expect(entry?.hasCredentials).toBe(true);
    expect(entry?.needsReauth).toBeFalsy();
  });

  test("regression guard: saveCredentials on invalid_credentials still says 'check your username and password'", async () => {
    const t = convexTest(schema, modules);
    stubFetch(
      loginOnly({ error: "Invalid credentials", error_class: "invalid_credentials" }, 422),
    );

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, {
        site: "sportlots",
        username: "real-user",
        password: "wrong-pass",
      });

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      "Could not sign in to SportLots. Nothing was saved — check your username and password and try again.",
    );
    const entry = await getRawEntry(t, USER_A, "sportlots");
    expect(entry?.hasCredentials).toBeFalsy();
  });
});

describe("self-recovery — a successful auth restores credential status (NEO-140)", () => {
  test("a successful test clears needsReauth AND re-asserts hasCredentials", async () => {
    // The gap NEO-140 called out: neither authenticate* action ever wrote the
    // flag on success, so a user whose flag had been wrongly wiped could
    // authenticate successfully and STILL be told they have no credentials.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: USER_A,
        siteCredentials: [
          {
            site: SITE,
            hasCredentials: false,
            needsReauth: true,
            needsReauthSince: 1_700_000_000_000,
          },
        ],
      });
    });

    stubFetch((async (url: string | URL | Request) => {
      if (String(url).includes("/login/bsc")) {
        return jsonResponse({ success: true, message: "ok", storeName: "Acme Cards" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as FetchStub);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.testSiteCredentials, { site: SITE });

    expect(result.success).toBe(true);
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry?.hasCredentials).toBe(true);
    expect(entry?.needsReauth).toBeFalsy();
    expect(entry?.needsReauthSince).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// NEO-278 — re-auth backoff in getSiteToken
//
// Since NEO-141 the browser service holds no password, so once a session has
// lapsed every stored-session login answers `reauth_required` in ~100ms until
// the user signs in again. `getSiteToken` used to re-run that doomed login on
// EVERY fetch (2026-09-14: ~1,500 pointless logins in a day, NEO-43 alert
// never clearing). Now, while `needsReauth` is flagged and the last
// observation is younger than 15 minutes, the refresh is skipped and the
// cached token (or null on the mint path) is returned directly. After 15
// minutes one attempt is made again, and any successful login clears it.
// ---------------------------------------------------------------------------
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/** Seed a flagged row with a `reauth_required` observation `ageMs` ago. */
async function seedNeedsReauth(
  t: ReturnType<typeof convexTest>,
  userId: string,
  site: string,
  ageMs: number,
  extra: { needsReauthSince?: number } = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("userProfiles", {
      userId,
      siteCredentials: [
        {
          site,
          hasCredentials: true,
          needsReauth: true,
          needsReauthSince: extra.needsReauthSince ?? Date.now() - ageMs,
          reauthObservedAt: Date.now() - ageMs,
        },
      ],
    });
  });
}

const STALE_TOKEN = { token: "tok-stale", expiresAt: Date.now() - 60_000 };

/** The browser service's answer for a lapsed session it cannot renew. */
function reauthRequiredResponse() {
  return jsonResponse(
    { error: "Authentication failed", error_class: "reauth_required" },
    422,
  );
}

describe("getSiteToken — re-auth backoff (NEO-278)", () => {
  test("flagged 1 minute ago: returns the cached token with NO login attempt", async () => {
    const t = convexTest(schema, modules);
    await seedNeedsReauth(t, USER_A, SITE, 60_000);
    const seen = { loginAttempts: 0 };
    stubFetch(
      tokenAndLoginStub(() => jsonResponse(STALE_TOKEN), reauthRequiredResponse, seen),
    );

    const token = await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });

    // Same fallback a failed refresh takes: hand back what we have.
    expect(token?.token).toBe("tok-stale");
    // The whole point: no authenticate action, no login POST.
    expect(seen.loginAttempts).toBe(0);
    // Nothing written — flag, stamps and credentials all as seeded.
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry?.hasCredentials).toBe(true);
    expect(entry?.needsReauth).toBe(true);
    expect(entry?.lockToken).toBeUndefined();
  });

  test("flagged 1 minute ago on the mint path (204): returns null with NO login attempt", async () => {
    const t = convexTest(schema, modules);
    await seedNeedsReauth(t, USER_A, SITE, 60_000);
    const seen = { loginAttempts: 0 };
    stubFetch(
      tokenAndLoginStub(
        () => new Response(null, { status: 204 }),
        reauthRequiredResponse,
        seen,
      ),
    );

    const token = await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });

    expect(token).toBeNull();
    expect(seen.loginAttempts).toBe(0);
    // NEO-140 invariant holds: nothing deleted.
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry?.hasCredentials).toBe(true);
    expect(entry?.needsReauth).toBe(true);
  });

  test("flagged 20 minutes ago: authenticate runs ONCE, re-stamps the observation, then backs off again", async () => {
    const t = convexTest(schema, modules);
    const firstDetected = Date.now() - 3 * 60 * 60 * 1000; // 3h ago
    await seedNeedsReauth(t, USER_A, SITE, 20 * 60 * 1000, {
      needsReauthSince: firstDetected,
    });
    const seen = { loginAttempts: 0 };
    stubFetch(
      tokenAndLoginStub(() => jsonResponse(STALE_TOKEN), reauthRequiredResponse, seen),
    );

    const before = Date.now();
    const token = await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });

    // The retry is kept: the service may have grown a silent re-auth by now.
    expect(seen.loginAttempts).toBe(1);
    // It failed again, so we fall back to the cached token as before.
    expect(token?.token).toBe("tok-stale");

    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry?.needsReauth).toBe(true);
    // Still flagged, still not deleted (NEO-140 / NEO-141).
    expect(entry?.hasCredentials).toBe(true);
    // "first detected" is preserved; "last observed" moved to now.
    expect(entry?.needsReauthSince).toBe(firstDetected);
    expect(entry?.reauthObservedAt).toBeGreaterThanOrEqual(before);
    // Lock released after the attempt.
    expect(entry?.lockToken).toBeUndefined();

    // A second fetch straight after is inside the fresh window: no login.
    const again = await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });
    expect(again?.token).toBe("tok-stale");
    expect(seen.loginAttempts).toBe(1);
  });

  test("flagged exactly at the boundary (15 minutes ago) retries", async () => {
    const t = convexTest(schema, modules);
    await seedNeedsReauth(t, USER_A, SITE, FIFTEEN_MINUTES_MS);
    const seen = { loginAttempts: 0 };
    stubFetch(
      tokenAndLoginStub(() => jsonResponse(STALE_TOKEN), reauthRequiredResponse, seen),
    );

    await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });

    expect(seen.loginAttempts).toBe(1);
  });

  test("a flag with no observation stamp (pre-NEO-278 row) is not in backoff: retries once and gets stamped", async () => {
    // Rows flagged before `reauthObservedAt` existed — and rows flagged by
    // testing.markSiteNeedsReauth — carry only `needsReauthSince`. They must
    // not be suppressed forever, nor treated as freshly observed.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: USER_A,
        siteCredentials: [
          {
            site: SITE,
            hasCredentials: true,
            needsReauth: true,
            needsReauthSince: Date.now() - 30_000,
          },
        ],
      });
    });
    const seen = { loginAttempts: 0 };
    stubFetch(
      tokenAndLoginStub(() => jsonResponse(STALE_TOKEN), reauthRequiredResponse, seen),
    );

    await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });
    expect(seen.loginAttempts).toBe(1);
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(typeof entry?.reauthObservedAt).toBe("number");

    // ...and from then on the backoff applies.
    await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });
    expect(seen.loginAttempts).toBe(1);
  });

  test("no flag at all: a stale token still refreshes on every call (unchanged behaviour)", async () => {
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, SITE);
    const seen = { loginAttempts: 0 };
    // A transient failure that is NOT reauth_required must not start a backoff.
    stubFetch(
      tokenAndLoginStub(
        () => jsonResponse(STALE_TOKEN),
        () => jsonResponse({ error: "marketplace down" }, 500),
        seen,
      ),
    );

    await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });
    await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });

    expect(seen.loginAttempts).toBe(2);
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry?.needsReauth).toBeFalsy();
    expect(entry?.reauthObservedAt).toBeUndefined();
  });

  test("a successful user-initiated login (Test Credentials) clears the backoff", async () => {
    const t = convexTest(schema, modules);
    await seedNeedsReauth(t, USER_A, SITE, 60_000);
    const seen = { loginAttempts: 0 };
    stubFetch(
      tokenAndLoginStub(
        () => jsonResponse(STALE_TOKEN),
        () => jsonResponse({ success: true, message: "ok" }),
        seen,
      ),
    );

    // The user clicks "Test" — never subject to the backoff.
    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.testSiteCredentials, { site: SITE });
    expect(result.success).toBe(true);
    expect(seen.loginAttempts).toBe(1);

    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry?.needsReauth).toBeFalsy();
    expect(entry?.needsReauthSince).toBeUndefined();
    expect(entry?.reauthObservedAt).toBeUndefined();

    // With the flag gone, the next stale-token fetch refreshes normally.
    await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });
    expect(seen.loginAttempts).toBe(2);
  });

  test("a successful saveCredentials (connect-and-store) clears the backoff", async () => {
    const t = convexTest(schema, modules);
    await seedNeedsReauth(t, USER_A, SITE, 60_000);
    const seen = { loginAttempts: 0 };
    stubFetch(
      tokenAndLoginStub(
        () => jsonResponse(STALE_TOKEN),
        () => jsonResponse({ success: true, message: "ok" }),
        seen,
      ),
    );

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, {
        site: SITE,
        username: "user@example.com",
        password: "hunter2",
      });
    expect(result.success).toBe(true);
    expect(seen.loginAttempts).toBe(1);

    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry?.hasCredentials).toBe(true);
    expect(entry?.needsReauth).toBeFalsy();
    expect(entry?.reauthObservedAt).toBeUndefined();

    await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });
    expect(seen.loginAttempts).toBe(2);
  });

  test("the backoff is per (user, site): BSC flagged does not suppress a SportLots refresh", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: USER_A,
        siteCredentials: [
          {
            site: "buysportscards",
            hasCredentials: true,
            needsReauth: true,
            needsReauthSince: Date.now() - 60_000,
            reauthObservedAt: Date.now() - 60_000,
          },
          { site: "sportlots", hasCredentials: true },
        ],
      });
    });
    const logins: string[] = [];
    stubFetch((async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/token")) return jsonResponse(STALE_TOKEN);
      if (u.includes("/login/")) {
        logins.push(u);
        return jsonResponse({ success: true, message: "ok" });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as FetchStub);

    await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: "buysportscards" });
    await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: "sportlots" });

    expect(logins).toHaveLength(1);
    expect(logins[0]).toContain("/login/sportlots");
  });

  test("a reauthObservedAt in the future (clock skew) still suppresses — but does not suppress past its own window, so it is not forever", async () => {
    // sinceMs = Date.now() - reauthObservedAt is negative when the stamp is
    // ahead of "now", which is < REAUTH_RETRY_INTERVAL_MS just like a very
    // recent stamp — so a skewed-forward stamp reads as "freshly observed"
    // and backs off. It does not become a permanent suppression: once real
    // time passes reauthObservedAt + REAUTH_RETRY_INTERVAL_MS, sinceMs is
    // positive and past the threshold, exactly as for any other stamp.
    const t = convexTest(schema, modules);
    const skewedFuture = Date.now() + 5 * 60 * 1000; // 5 minutes ahead
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: USER_A,
        siteCredentials: [
          {
            site: SITE,
            hasCredentials: true,
            needsReauth: true,
            needsReauthSince: skewedFuture,
            reauthObservedAt: skewedFuture,
          },
        ],
      });
    });
    const seen = { loginAttempts: 0 };
    stubFetch(
      tokenAndLoginStub(() => jsonResponse(STALE_TOKEN), reauthRequiredResponse, seen),
    );

    const token = await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });

    expect(token?.token).toBe("tok-stale");
    expect(seen.loginAttempts).toBe(0);

    // Simulate real time catching up past reauthObservedAt + the interval —
    // the backoff must lift, proving it is bounded rather than permanent.
    vi.useFakeTimers();
    vi.setSystemTime(skewedFuture + FIFTEEN_MINUTES_MS + 1000);
    try {
      await t
        .withIdentity({ subject: USER_A })
        .action(internal.credentials.getSiteToken, { site: SITE });
      expect(seen.loginAttempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a not_found secret is self-healed even while the site is in active backoff", async () => {
    // readCachedToken's "not_found" branch runs BEFORE refreshSiteToken (and
    // therefore before inReauthBackoff is ever consulted), so a genuinely
    // deleted secret must still clear the stale needsReauth flag rather than
    // being masked by the backoff meant for doomed re-auth attempts.
    const t = convexTest(schema, modules);
    await seedNeedsReauth(t, USER_A, SITE, 60_000); // well inside the backoff window
    stubFetch((async (url: string | URL | Request) => {
      if (String(url).includes("/token")) {
        return jsonResponse({ error: "Credentials not found" }, 404);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as FetchStub);

    const token = await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: SITE });

    expect(token).toBeNull();
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NEO-143 — browser-service contract guard
//
// Convex and the browser service go live at different moments, so every release
// passes through a window where one is new and the other is old. Merging
// NEO-141 turned that window into a production outage.
//
// The mode these tests exist for is the QUIET one. NEO-141 moved the password
// onto a transient field of the login request; an older service ignores that
// field and logs in with the stored secret instead, so a password change
// appears to succeed while the OLD password is silently used. There is no way
// to detect that from the response — by then the login has happened. So the
// assertion that matters below is not "it failed", it is "/login was never
// called at all".
// ---------------------------------------------------------------------------
describe("browser-service contract guard (NEO-143)", () => {
  /** Stub that serves a chosen /health body and records every other call. */
  function guardStub(health: unknown, status = 200) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/health")) return jsonResponse(health, status);
      calls.push(u);
      return jsonResponse({ success: true, message: "ok" });
    }) as FetchStub);
    return calls;
  }

  test("a service predating the guard (no contractVersion) never receives the login", async () => {
    const t = convexTest(schema, modules);
    // Exactly what the currently-deployed pre-NEO-143 service answers.
    const calls = guardStub({ status: "ok", environment: "prod" });

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, {
        site: SITE,
        username: "real-user",
        password: "real-pass",
      });

    expect(result.success).toBe(false);
    // THE assertion: the request whose shape an old service would misread was
    // never sent. A guard that fails after the call would be worthless here.
    expect(calls).toHaveLength(0);
    // And no credential was recorded on the back of it. (A row exists because
    // withCredentialLock writes the lock before running the body; what matters
    // is that it never flipped to hasCredentials.)
    expect((await getRawEntry(t, USER_A, SITE))?.hasCredentials).toBeFalsy();
  });

  test("the failure is reported as a deploy in progress, not as bad credentials", async () => {
    const t = convexTest(schema, modules);
    guardStub({ status: "ok", environment: "prod", contractVersion: 0 });

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, {
        site: SITE,
        username: "real-user",
        password: "real-pass",
      });

    expect(result.success).toBe(false);
    // Telling a user to re-check a correct password sends them to change it for
    // no reason. The copy must point at the deploy, not at them.
    expect(result.message).toMatch(/updating/i);
    expect(result.message).not.toMatch(/check your username|password/i);
  });

  test("an unreachable /health blocks the call rather than assuming compatibility", async () => {
    const t = convexTest(schema, modules);
    const calls = guardStub({ error: "unavailable" }, 503);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, {
        site: SITE,
        username: "real-user",
        password: "real-pass",
      });

    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("a current service is probed once, then served from cache", async () => {
    const t = convexTest(schema, modules);
    let healthProbes = 0;
    const logins: string[] = [];
    vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/health")) {
        healthProbes += 1;
        return jsonResponse({ status: "ok", environment: "test", contractVersion: 1 });
      }
      logins.push(u);
      return jsonResponse({ success: true, message: "ok" });
    }) as FetchStub);

    for (let i = 0; i < 3; i++) {
      const result = await t
        .withIdentity({ subject: USER_A })
        .action(api.credentials.saveCredentials, {
          site: SITE,
          username: "real-user",
          password: "real-pass",
        });
      expect(result.success).toBe(true);
    }

    expect(logins).toHaveLength(3);
    // Cached — the probe must not become a per-request tax on every credential
    // operation.
    expect(healthProbes).toBe(1);
  });

  test("a too-old result is NOT cached, so recovery is immediate once promoted", async () => {
    const t = convexTest(schema, modules);
    let version = 0; // mid-deploy: old revision still serving
    const logins: string[] = [];
    vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/health")) {
        return jsonResponse({ status: "ok", environment: "test", contractVersion: version });
      }
      logins.push(u);
      return jsonResponse({ success: true, message: "ok" });
    }) as FetchStub);

    const blocked = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, {
        site: SITE,
        username: "real-user",
        password: "real-pass",
      });
    expect(blocked.success).toBe(false);
    expect(logins).toHaveLength(0);

    // The new revision reaches 100% traffic.
    version = 1;

    // Caching the negative would strand the user behind a 60s TTL after the
    // service is already healthy — turning a seconds-long deploy window into a
    // minutes-long outage.
    const recovered = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, {
        site: SITE,
        username: "real-user",
        password: "real-pass",
      });
    expect(recovered.success).toBe(true);
    expect(logins).toHaveLength(1);
  });
});

// ===========================================================================
// NEO-287 — the operator pause switch
// ===========================================================================
//
// `NEONBINDER_PAUSED_PLATFORMS` is read fresh on every call (see
// `convex/marketplacePause.ts`), so setting it in a test is enough — no
// deploy, no cache to reset. Every path below must refuse BEFORE the browser
// service is contacted: zero fetch calls is the whole guarantee.

describe("marketplace paused (NEO-287)", () => {
  afterEach(() => {
    delete process.env.NEONBINDER_PAUSED_PLATFORMS;
  });

  test("saveCredentials on a paused site returns the paused message verbatim, calls no fetch, writes nothing", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots";
    const t = convexTest(schema, modules);
    let fetchCalled = false;
    stubFetch((async () => {
      fetchCalled = true;
      throw new Error("must not reach the browser service while paused");
    }) as FetchStub);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, {
        site: "sportlots",
        username: "real-user",
        password: "real-pass",
      });

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      "SportLots sign-ins are on pause right now. Nothing was changed — your saved session is safe.",
    );
    expect(fetchCalled).toBe(false);
    const entry = await getRawEntry(t, USER_A, "sportlots");
    expect(entry?.hasCredentials).toBeFalsy();
    expect(entry?.needsReauth).toBeFalsy();
  });

  test("saveCredentials on a paused site leaves a pre-existing needsReauth flag untouched", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots";
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: USER_A,
        siteCredentials: [
          {
            site: "sportlots",
            hasCredentials: true,
            needsReauth: true,
            needsReauthSince: 1_700_000_000_000,
          },
        ],
      });
    });
    stubFetch((async () => {
      throw new Error("must not reach the browser service while paused");
    }) as FetchStub);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, {
        site: "sportlots",
        username: "real-user",
        password: "real-pass",
      });

    expect(result.success).toBe(false);
    const entry = await getRawEntry(t, USER_A, "sportlots");
    // Neither cleared nor re-flagged — a pause is not a login outcome.
    expect(entry?.needsReauth).toBe(true);
    expect(entry?.needsReauthSince).toBe(1_700_000_000_000);
    expect(entry?.hasCredentials).toBe(true);
  });

  test("testSiteCredentials on a paused site returns the paused message, calls no fetch, and records no credential test", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots";
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, "sportlots");
    let fetchCalled = false;
    stubFetch((async () => {
      fetchCalled = true;
      throw new Error("must not reach the browser service while paused");
    }) as FetchStub);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.testSiteCredentials, { site: "sportlots" });

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      "SportLots sign-ins are on pause right now. Nothing was changed — your saved session is safe.",
    );
    expect(fetchCalled).toBe(false);
    // hasCredentials and needsReauth are exactly as seeded — a pause is not a
    // credential test outcome, so `recordCredentialTest` never runs and
    // nothing is written (the only way to observe that from here — PostHog
    // capture itself is a fire-and-forget best-effort call, see
    // observability.ts).
    const entry = await getRawEntry(t, USER_A, "sportlots");
    expect(entry?.hasCredentials).toBe(true);
    expect(entry?.needsReauth).toBeFalsy();
  });

  test("getSiteToken on a paused site returns null without any fetch", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots";
    const t = convexTest(schema, modules);
    await seedHasCredentials(t, USER_A, "sportlots");
    let fetchCalled = false;
    stubFetch((async () => {
      fetchCalled = true;
      throw new Error("must not reach the browser service while paused");
    }) as FetchStub);

    const token = await t
      .withIdentity({ subject: USER_A })
      .action(internal.credentials.getSiteToken, { site: "sportlots" });

    expect(token).toBeNull();
    expect(fetchCalled).toBe(false);
  });

  test("pausing SportLots does not stop BSC from logging in with the same env set", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots";
    const t = convexTest(schema, modules);
    const calls: string[] = [];
    stubFetch((async (url: string | URL | Request) => {
      calls.push(String(url));
      return jsonResponse({ success: true, message: "ok" });
    }) as FetchStub);

    const result = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, {
        site: SITE, // buysportscards
        username: "real-user",
        password: "real-pass",
      });

    expect(result.success).toBe(true);
    expect(calls.some((u) => u.includes("/login/bsc"))).toBe(true);
  });

  test("pausing BOTH known sites via a comma-separated value refuses both", async () => {
    process.env.NEONBINDER_PAUSED_PLATFORMS = "sportlots,buysportscards";
    const t = convexTest(schema, modules);
    let fetchCalled = false;
    stubFetch((async () => {
      fetchCalled = true;
      throw new Error("must not reach the browser service while paused");
    }) as FetchStub);

    const sl = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, {
        site: "sportlots",
        username: "u",
        password: "p",
      });
    const bsc = await t
      .withIdentity({ subject: USER_A })
      .action(api.credentials.saveCredentials, {
        site: SITE,
        username: "u",
        password: "p",
      });

    expect(sl.success).toBe(false);
    expect(bsc.success).toBe(false);
    expect(fetchCalled).toBe(false);
  });
});
