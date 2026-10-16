import { afterEach, describe, expect, test, vi } from "vitest";
import { fakeJwt } from "./auth/test-helpers";
import { COMMANDS, main, whoami, type CliIO } from "./cli";
import type { Connection } from "./client/connect";
import { parseTarget } from "./client/target";

const fake = vi.hoisted(() => ({
  queryResult: undefined as unknown,
  queryError: undefined as Error | undefined,
  queried: [] as string[],
  closed: 0,
}));

vi.mock("convex/browser", () => {
  class ConvexClient {
    setAuth() {}
    async query(fn: unknown) {
      const { getFunctionName } = await import("convex/server");
      fake.queried.push(getFunctionName(fn as never));
      if (fake.queryError) throw fake.queryError;
      return fake.queryResult;
    }
    async close() {
      fake.closed++;
    }
  }
  class ConvexHttpClient {}
  return { ConvexClient, ConvexHttpClient };
});

function io(env: NodeJS.ProcessEnv = {}): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, env, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
}

const NOW = 1_800_000_000_000;
function connection(): Connection {
  const token = fakeJwt({ sub: "user_abc", role: "admin", aud: "convex", exp: NOW / 1000 + 600 });
  return {
    target: parseTarget("https://happy-otter-123.convex.cloud"),
    auth: "testing",
    transport: "ws",
    tokens: { getToken: async () => token, describe: () => "fake source" },
  };
}

afterEach(() => {
  fake.queryResult = undefined;
  fake.queryError = undefined;
  fake.queried = [];
  fake.closed = 0;
  delete COMMANDS.__boom;
});

describe("main", () => {
  test("no command prints usage and exits 2; help exits 0", async () => {
    const a = io();
    expect(await main([], a)).toBe(2);
    expect(a.out.join("\n")).toContain("whoami");
    const b = io();
    expect(await main(["help"], b)).toBe(0);
  });

  test("an unknown command or flag is a usage error", async () => {
    const a = io();
    expect(await main(["nope"], a)).toBe(2);
    expect(a.err[0]).toContain('unknown command "nope"');
    const b = io();
    expect(await main(["whoami", "--api-key", "x"], b)).toBe(2);
  });

  test("a config error exits 1 and names what is missing", async () => {
    const a = io();
    expect(await main(["whoami", "--auth", "testing"], a)).toBe(1);
    expect(a.err[0]).toMatch(/NB_SETBUILD_CONVEX_URL/);
  });

  test("a failing command's message is scrubbed of every secret env value", async () => {
    COMMANDS.__boom = {
      summary: "test only",
      usage: "setbuild __boom",
      run: async () => {
        throw new Error("upstream said key=ak_secret_value_1 secret=tes_secret_value_2");
      },
    };
    const a = io({ NB_SETBUILD_API_KEY: "ak_secret_value_1", TESTING_ENDPOINT_SECRET: "tes_secret_value_2" });
    expect(await main(["__boom"], a)).toBe(1);
    expect(a.err[0]).toBe("setbuild __boom: upstream said key=[redacted] secret=[redacted]");
  });
});

describe("main: JWT-shaped strings are scrubbed too (security audit item 3)", () => {
  test("a token in a failing command's message never reaches stderr", async () => {
    const jwt = fakeJwt({ sub: "user_abc", aud: "convex", exp: 1_900_000_000 });
    COMMANDS.__boom = {
      summary: "test only",
      usage: "setbuild __boom",
      run: async () => {
        throw new Error(`upstream echoed Authorization: Bearer ${jwt} and key=ak_secret_value_1`);
      },
    };
    const a = io({ NB_SETBUILD_API_KEY: "ak_secret_value_1" });
    expect(await main(["__boom"], a)).toBe(1);
    expect(a.err[0]).toBe("setbuild __boom: upstream echoed Authorization: Bearer [redacted-token] and key=[redacted]");
  });
});

describe("whoami", () => {
  test("reports subject, role and a passing admin probe", async () => {
    fake.queryResult = { leagues: [], totalCount: 23, truncated: false };
    const report = await whoami(connection(), () => NOW);
    expect(report).toEqual({
      target: { convexUrl: "https://happy-otter-123.convex.cloud", host: "happy-otter-123.convex.cloud" },
      auth: "fake source",
      subject: "user_abc",
      role: "admin",
      expiresInSeconds: 600,
      admin: { ok: true, probe: "leagues:listForManagement", detail: "returned 23 leagues" },
    });
    expect(fake.queried).toEqual(["leagues:listForManagement"]);
    expect(fake.closed).toBe(1);
  });

  test("a refused probe is reported, not thrown, and the client still closes", async () => {
    fake.queryError = new Error("Admin access required\n    at handler (leagues.ts:1)");
    const report = await whoami(connection(), () => NOW);
    expect(report.admin).toEqual({ ok: false, probe: "leagues:listForManagement", detail: "Admin access required" });
    expect(fake.closed).toBe(1);
  });
});
