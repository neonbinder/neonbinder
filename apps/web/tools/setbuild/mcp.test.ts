/**
 * NEO-339 — the MCP server reads PAUSED_PLATFORMS from the environment it was
 * started with, exactly as the CLI's `--paused-platforms` defaults to it
 * (security audit item 7).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const seen = vi.hoisted(() => ({ opts: [] as unknown[] }));

vi.mock("./client/convex-client", () => ({
  makeClient: (target: unknown) => ({ target, transport: "ws", close: async () => {} }),
}));

vi.mock("./runner/service", () => ({
  createSetBuildService: (_client: unknown, target: unknown, opts: unknown) => {
    seen.opts.push(opts);
    const read = async () => ({ found: false, pathText: "Baseball/2024/Topps" });
    return {
      target,
      read: { inspect: read, plan: read, reviewItems: read },
      write: { apply: read, decide: read, buildParallel: read, slReviewApply: read },
    };
  },
}));

import { buildServer } from "./mcp";

const ENV = {
  NB_SETBUILD_CONVEX_URL: "https://happy-otter-123.convex.cloud",
  NB_SETBUILD_AUTH: "machine",
  NB_SETBUILD_API_KEY: "ak_secret_value_for_mcp_test",
};

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
  seen.opts = [];
});

async function inspectOnce(env: NodeJS.ProcessEnv) {
  const { server, close } = buildServer(env);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "mcp-env-test", version: "0.0.0" });
  await client.connect(c);
  open.push(async () => {
    await client.close();
    await server.close();
    await close();
  });
  const r = await client.callTool({
    name: "nb_inspect",
    arguments: { path: { sport: "Baseball", year: "2024", manufacturer: "Topps" } },
  });
  expect(r.isError).not.toBe(true);
}

describe("buildServer", () => {
  test("hands the service PAUSED_PLATFORMS from its own env", async () => {
    await inspectOnce({ ...ENV, PAUSED_PLATFORMS: "sportlots" });
    expect(seen.opts).toEqual([{ pausedPlatforms: "sportlots" }]);
  });

  test('.mcp.json\'s "${PAUSED_PLATFORMS:-}" (empty) means nothing paused, not "fall back"', async () => {
    await inspectOnce({ ...ENV, PAUSED_PLATFORMS: "" });
    expect(seen.opts).toEqual([{ pausedPlatforms: "" }]);
  });

  test("machine auth with a site URL that is not the twin never builds a service", async () => {
    const { server, close } = buildServer({ ...ENV, NB_SETBUILD_CONVEX_SITE_URL: "https://evil.example.com" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "mcp-env-test", version: "0.0.0" });
    await client.connect(c);
    open.push(async () => {
      await client.close();
      await server.close();
      await close();
    });
    const r = await client.callTool({
      name: "nb_inspect",
      arguments: { path: { sport: "Baseball", year: "2024", manufacturer: "Topps" } },
    });
    expect(r.isError).toBe(true);
    const text = (r.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("");
    expect(JSON.parse(text)).toMatchObject({ error: "config" });
    expect(text).not.toContain("ak_secret_value_for_mcp_test");
    expect(seen.opts).toEqual([]);
  });
});
