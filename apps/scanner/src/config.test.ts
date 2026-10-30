import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { configPath, convexUrlIn, looksLikeCode, resolveConvexUrl, savedKey, saveKey } from "./config.js";
import { bundledRuntime } from "./sane.js";

const PAGE = '<head><meta name="x-convex-url" content="https://happy-otter-123.convex.cloud" /></head>';

describe("convexUrlIn", () => {
  test("reads the deployment a NeonBinder page names", () => {
    expect(convexUrlIn(PAGE)).toBe("https://happy-otter-123.convex.cloud");
  });
  test("refuses anything that isn't a Convex deployment", () => {
    expect(convexUrlIn('<meta name="x-convex-url" content="https://evil.example.com" />')).toBeUndefined();
    expect(convexUrlIn("<head></head>")).toBeUndefined();
  });
});

describe("resolveConvexUrl", () => {
  test("an explicit URL wins and nothing is fetched", async () => {
    const fetchImpl = vi.fn();
    expect(await resolveConvexUrl({ convexUrl: "https://x-y-1.convex.cloud" }, fetchImpl)).toBe("https://x-y-1.convex.cloud");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  const landedOn = (url: string, body = PAGE) => {
    const res = new Response(body);
    Object.defineProperty(res, "url", { value: url });
    return res;
  };
  test("otherwise asks the site", async () => {
    const fetchImpl = vi.fn(async () => landedOn("https://www.neonbinder.io/"));
    expect(await resolveConvexUrl({}, fetchImpl as unknown as typeof fetch)).toBe("https://happy-otter-123.convex.cloud");
    expect(fetchImpl).toHaveBeenCalledWith("https://www.neonbinder.io", expect.anything());
  });
  test("won't believe a page a redirect took it off NeonBinder to", async () => {
    const fetchImpl = vi.fn(async () => landedOn("https://neonbinder.example.com/"));
    await expect(resolveConvexUrl({}, fetchImpl as unknown as typeof fetch)).rejects.toThrow(/somewhere unexpected/);
  });
  test("says so plainly when the site can't be reached", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(resolveConvexUrl({}, fetchImpl as unknown as typeof fetch)).rejects.toThrow(/Can't reach NeonBinder/);
  });
  test("won't ask a plain-http site", async () => {
    await expect(resolveConvexUrl({ site: "http://neonbinder.io" })).rejects.toThrow(/https/);
  });
});

describe("the saved key", () => {
  test("is kept per backend, readable by this user only, and forgotten cleanly", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "nb-cfg-")), "NeonBinder", "scanner.json");
    expect(await savedKey(file, "https://a-b-1.convex.cloud")).toBeUndefined();
    await saveKey(file, "https://a-b-1.convex.cloud", "key-prod");
    await saveKey(file, "https://c-d-2.convex.cloud", "key-preview");
    expect(await savedKey(file, "https://a-b-1.convex.cloud")).toBe("key-prod");
    expect(await savedKey(file, "https://c-d-2.convex.cloud")).toBe("key-preview");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    await saveKey(file, "https://a-b-1.convex.cloud", undefined);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ keys: { "https://c-d-2.convex.cloud": "key-preview" } });
    await saveKey(file, "https://c-d-2.convex.cloud", undefined);
    await expect(stat(file)).rejects.toThrow();
  });
  test("lives in the usual settings folder", () => {
    expect(configPath("darwin", "/Users/sam")).toBe("/Users/sam/Library/Application Support/NeonBinder/scanner.json");
  });
});

describe("looksLikeCode", () => {
  test("takes the code however it's typed", () => {
    expect(looksLikeCode("abc 123")).toBe(true);
    expect(looksLikeCode("ABC-123")).toBe(true);
    expect(looksLikeCode("ABC12")).toBe(false);
  });
});

describe("bundledRuntime", () => {
  test("runs the bundled scanimage against the bundle's own libraries and config", () => {
    const sane = bundledRuntime("/cache/sane-abc", { HOME: "/Users/sam", NEONBINDER_API_KEY: "secret" });
    expect(sane.env.NEONBINDER_API_KEY).toBeUndefined();
    expect(sane.scanimage).toBe("/cache/sane-abc/bin/scanimage");
    expect(sane.env).toMatchObject({
      HOME: "/Users/sam",
      DYLD_LIBRARY_PATH: "/cache/sane-abc/lib:/cache/sane-abc/lib/sane",
      LD_LIBRARY_PATH: "/cache/sane-abc/lib/sane",
      SANE_CONFIG_DIR: "/cache/sane-abc/etc",
    });
  });
});
