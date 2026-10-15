import { describe, expect, test } from "vitest";
import { publishableKeyFor } from "../auth/test-helpers";
import { ConfigError, resolveConnection, secretValues } from "./connect";
import { TargetError } from "./target";

const CONVEX = "https://happy-otter-123.convex.cloud";
const PK = publishableKeyFor("foo-bar-1.clerk.accounts.dev");
const SECRET = "testing-endpoint-secret-abcdef";

describe("resolveConnection", () => {
  test("testing mode from env alone", () => {
    const conn = resolveConnection(
      {},
      {
        NB_SETBUILD_CONVEX_URL: CONVEX,
        NB_SETBUILD_AUTH: "testing",
        NB_SETBUILD_APP_URL: "http://localhost:3005",
        TESTING_ENDPOINT_SECRET: SECRET,
        VITE_CLERK_PUBLISHABLE_KEY: PK,
      },
    );
    expect(conn.auth).toBe("testing");
    expect(conn.transport).toBe("ws");
    expect(conn.target.host).toBe("happy-otter-123.convex.cloud");
    expect(conn.tokens.describe()).toContain("worker 0");
    expect(conn.tokens.describe()).not.toContain(SECRET);
  });

  test("the app URL's origin rides on the target for Set Builder links, in both auth modes", () => {
    const testing = resolveConnection(
      {},
      {
        NB_SETBUILD_CONVEX_URL: CONVEX,
        NB_SETBUILD_AUTH: "testing",
        NB_SETBUILD_APP_URL: "http://localhost:3005/some/path",
        TESTING_ENDPOINT_SECRET: SECRET,
        VITE_CLERK_PUBLISHABLE_KEY: PK,
      },
    );
    expect(testing.target.appOrigin).toBe("http://localhost:3005");
    const machine = resolveConnection(
      { auth: "machine", appUrl: "https://app.example.test/" },
      { NB_SETBUILD_CONVEX_URL: CONVEX, NB_SETBUILD_API_KEY: "ak_key_value_123" },
    );
    expect(machine.target.appOrigin).toBe("https://app.example.test");
  });

  test("machine auth without an app URL: no origin (links stay root-relative); a junk one is refused", () => {
    const env = { NB_SETBUILD_CONVEX_URL: CONVEX, NB_SETBUILD_API_KEY: "ak_key_value_123" };
    expect(resolveConnection({ auth: "machine" }, env).target.appOrigin).toBeUndefined();
    expect(() => resolveConnection({ auth: "machine", appUrl: "not a url" }, env)).toThrow(ConfigError);
    expect(() => resolveConnection({ auth: "machine", appUrl: "ftp://app.example.test" }, env)).toThrow(ConfigError);
  });

  test("flags win over env", () => {
    const conn = resolveConnection(
      { auth: "machine", convexUrl: "https://other-9.convex.cloud", transport: "http" },
      { NB_SETBUILD_CONVEX_URL: CONVEX, NB_SETBUILD_AUTH: "testing", NB_SETBUILD_API_KEY: "ak_key_value_123" },
    );
    expect(conn.auth).toBe("machine");
    expect(conn.transport).toBe("http");
    expect(conn.target.host).toBe("other-9.convex.cloud");
    expect(conn.tokens.describe()).toContain("other-9.convex.site/machine/token");
  });

  test("never falls back to VITE_CONVEX_URL", () => {
    expect(() =>
      resolveConnection({ auth: "testing" }, { VITE_CONVEX_URL: CONVEX }),
    ).toThrow(/NB_SETBUILD_CONVEX_URL/);
  });

  test("names every missing variable, never a value", () => {
    let caught: unknown;
    try {
      resolveConnection({ auth: "testing", convexUrl: CONVEX }, { VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-xyz-123" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const msg = (caught as Error).message;
    expect(msg).toContain("NB_SETBUILD_APP_URL");
    expect(msg).toContain("TESTING_ENDPOINT_SECRET");
    expect(msg).toContain("VITE_CLERK_PUBLISHABLE_KEY");
    expect(msg).not.toContain("bypass-xyz-123");
  });

  test("an auth mode is required and must be known", () => {
    expect(() => resolveConnection({ convexUrl: CONVEX }, {})).toThrow(/--auth machine\|testing/);
    expect(() => resolveConnection({ convexUrl: CONVEX, auth: "admin" }, {})).toThrow(ConfigError);
    expect(() => resolveConnection({ convexUrl: CONVEX, auth: "machine" }, {})).toThrow(/NB_SETBUILD_API_KEY/);
  });

  test("worker and transport are validated", () => {
    const env = {
      NB_SETBUILD_APP_URL: "http://localhost:3005",
      TESTING_ENDPOINT_SECRET: SECRET,
      VITE_CLERK_PUBLISHABLE_KEY: PK,
    };
    expect(() => resolveConnection({ auth: "testing", convexUrl: CONVEX, worker: "x" }, env)).toThrow(/--worker/);
    expect(() => resolveConnection({ auth: "testing", convexUrl: CONVEX, worker: "40" }, env)).toThrow(/--worker/);
    expect(() => resolveConnection({ auth: "testing", convexUrl: CONVEX, transport: "grpc" }, env)).toThrow(
      /--transport/,
    );
  });
});

describe("credential destinations (security audit item 1, 4)", () => {
  const testingEnv = {
    TESTING_ENDPOINT_SECRET: SECRET,
    VITE_CLERK_PUBLISHABLE_KEY: PK,
  };

  test("machine auth refuses a site URL that is not the Convex URL's .convex.site twin", () => {
    const env = { NB_SETBUILD_API_KEY: "ak_key_value_123" };
    for (const convexSiteUrl of ["https://evil.example.com", "https://prod-deploy-1.convex.site", "http://happy-otter-123.convex.site"]) {
      let caught: unknown;
      try {
        resolveConnection({ auth: "machine", convexUrl: CONVEX, convexSiteUrl }, env);
      } catch (e) {
        caught = e;
      }
      expect(caught, convexSiteUrl).toBeInstanceOf(TargetError);
      expect((caught as Error).message).not.toContain("ak_key_value_123");
    }
    // The twin itself, and a local backend, still resolve.
    expect(
      resolveConnection({ auth: "machine", convexUrl: CONVEX, convexSiteUrl: "https://happy-otter-123.convex.site" }, env).tokens.describe(),
    ).toContain("happy-otter-123.convex.site/machine/token");
    expect(resolveConnection({ auth: "machine", convexUrl: "http://127.0.0.1:3210" }, env).target.convexSite).toBe(
      "http://127.0.0.1:3211",
    );
  });

  test("a custom Convex domain cannot carry machine auth (no twin to bind)", () => {
    expect(() =>
      resolveConnection(
        { auth: "machine", convexUrl: "https://api.example.com", convexSiteUrl: "https://site.example.com" },
        { NB_SETBUILD_API_KEY: "ak_key_value_123" },
      ),
    ).toThrow(TargetError);
  });

  test("testing auth refuses a plain-http app URL off loopback", () => {
    expect(() =>
      resolveConnection({ auth: "testing", convexUrl: CONVEX, appUrl: "http://preview.example.com" }, testingEnv),
    ).toThrow(/https/);
    expect(resolveConnection({ auth: "testing", convexUrl: CONVEX, appUrl: "https://preview.example.com" }, testingEnv).auth).toBe(
      "testing",
    );
    expect(resolveConnection({ auth: "testing", convexUrl: CONVEX, appUrl: "http://127.0.0.1:3000" }, testingEnv).auth).toBe(
      "testing",
    );
  });

  test("testing auth refuses a production (pk_live_) Clerk key", () => {
    expect(() =>
      resolveConnection(
        { auth: "testing", convexUrl: CONVEX, appUrl: "https://preview.example.com" },
        { ...testingEnv, VITE_CLERK_PUBLISHABLE_KEY: PK.replace("pk_test_", "pk_live_") },
      ),
    ).toThrow(/pk_live_/);
  });
});

describe("secretValues", () => {
  test("collects only the secret variables that are set", () => {
    expect(
      secretValues({
        NB_SETBUILD_API_KEY: "a1",
        TESTING_ENDPOINT_SECRET: "",
        VERCEL_AUTOMATION_BYPASS_SECRET: "b2",
        VITE_CLERK_PUBLISHABLE_KEY: "pk",
      }),
    ).toEqual(["a1", "b2"]);
  });
});
