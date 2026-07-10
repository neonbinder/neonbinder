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

describe("saveCredentials — store branch (atomic flag update)", () => {
  test("successful PUT sets hasCredentials:true server-side, no second call needed", async () => {
    const t = convexTest(schema, modules);
    const stub: FetchStub = async (url, init) => {
      const u = String(url);
      if (u.includes("/credentials/") && init?.method === "PUT") {
        return jsonResponse({ success: true });
      }
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
  });

  test("failed PUT does NOT set hasCredentials — no partial/inconsistent state", async () => {
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
    // acquireCredentialLock creates the row on first touch (hasCredentials
    // defaults false) even though the store itself failed — the row existing
    // is fine; what matters is it does NOT claim credentials were saved.
    const entry = await getRawEntry(t, USER_A, SITE);
    expect(entry?.hasCredentials).toBeFalsy();
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
      if (u.includes("/token")) return jsonResponse({ error: "not found" }, 404);
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
      if (u.includes("/token")) return jsonResponse({ error: "not found" }, 404);
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
      if (u.includes("/token")) return jsonResponse({ error: "not found" }, 404);
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
