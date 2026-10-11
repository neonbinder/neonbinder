import { describe, expect, test } from "vitest";
import { publishableKeyFor } from "../auth/test-helpers";
import { ConfigError, resolveConnection, secretValues } from "./connect";

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
