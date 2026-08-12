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
    vi.stubGlobal("fetch", stub);

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
    vi.stubGlobal("fetch", stub);

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
    vi.stubGlobal("fetch", stub);

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
    vi.stubGlobal("fetch", stub);

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
    vi.stubGlobal("fetch", stub);

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
    vi.stubGlobal("fetch", stub);

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
    vi.stubGlobal("fetch", stub);

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
    vi.stubGlobal("fetch", stub);

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
    vi.stubGlobal("fetch", stub);

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
    vi.stubGlobal("fetch", stub);

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
    vi.stubGlobal("fetch", stub);

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
    vi.stubGlobal(
      "fetch",
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
    vi.stubGlobal("fetch", stub);

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
    vi.stubGlobal(
      "fetch",
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
    vi.stubGlobal(
      "fetch",
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
    vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
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
    vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
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
    vi.stubGlobal(
      "fetch",
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
    vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
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

    vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
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

    vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
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
