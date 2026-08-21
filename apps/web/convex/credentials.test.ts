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
    const stub: FetchStub = async () => jsonResponse({ error: "bad request" }, 400);
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
    // Lock fully released.
    expect(entry?.lockToken).toBeUndefined();
    expect(entry?.lockedAt).toBeUndefined();
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
