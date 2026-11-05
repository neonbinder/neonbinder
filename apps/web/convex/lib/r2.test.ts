/**
 * NEO-377 — R2 signing (`convex/lib/r2.ts`): no config without all four env
 * vars, and an upload URL signs its type and length so R2 takes exactly
 * those bytes.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { putObject, r2Config, signedGetUrl, signedPutUrl } from "./r2";

const ENV = {
  R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com/",
  R2_BUCKET: "photos",
  R2_ACCESS_KEY_ID: "AKIDEXAMPLE",
  R2_SECRET_ACCESS_KEY: "secret",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("r2", () => {
  test("is not configured unless every variable is set", () => {
    for (const missing of Object.keys(ENV)) {
      for (const [k, val] of Object.entries(ENV)) vi.stubEnv(k, k === missing ? "" : val);
      expect(r2Config()).toBeNull();
    }
  });

  test("an upload URL signs the content type and length, and expires", async () => {
    for (const [k, val] of Object.entries(ENV)) vi.stubEnv(k, val);
    const config = r2Config()!;
    const url = new URL(await signedPutUrl(config, "copy-photos/abc/image.jpg", "image/jpeg", 1234, 600));
    expect(url.origin + url.pathname).toBe("https://acct.r2.cloudflarestorage.com/photos/copy-photos/abc/image.jpg");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(
      expect.arrayContaining(["content-length", "content-type", "host"]),
    );
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.toString()).not.toContain("secret");
  });

  test("a server-side write sends the bytes and type, signed, to the object's key", async () => {
    for (const [k, val] of Object.entries(ENV)) vi.stubEnv(k, val);
    const seen: Request[] = [];
    vi.stubGlobal("fetch", (async (request: Request) => {
      seen.push(request);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch);
    await putObject(r2Config()!, "copy-photos/abc/image.jpg", new Uint8Array([1, 2, 3]), "image/jpeg", 5_000);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("PUT");
    expect(seen[0].url).toBe("https://acct.r2.cloudflarestorage.com/photos/copy-photos/abc/image.jpg");
    expect(seen[0].headers.get("content-type")).toBe("image/jpeg");
    expect(seen[0].headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(new Uint8Array(await seen[0].arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("a refused write throws, and says only the status", async () => {
    for (const [k, val] of Object.entries(ENV)) vi.stubEnv(k, val);
    vi.stubGlobal("fetch", (async () => new Response("<Error>secret detail</Error>", { status: 403 })) as unknown as typeof fetch);
    await expect(
      putObject(r2Config()!, "copy-photos/abc/image.jpg", new Uint8Array([1]), "image/jpeg", 5_000),
    ).rejects.toThrow(/^R2 PUT failed: 403$/);
  });

  test("a read URL is a signed GET", async () => {
    for (const [k, val] of Object.entries(ENV)) vi.stubEnv(k, val);
    const url = new URL(await signedGetUrl(r2Config()!, "copy-photos/abc/thumb.webp", 3600));
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });
});
