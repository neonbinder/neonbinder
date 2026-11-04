/**
 * NEO-427 — the two storage reads the photo attach makes (`adapters/gcs.ts`): a
 * missing object is an answer, an oversized one is refused without fetching it
 * whole, and any other failure stays a failure, because it says nothing about
 * whether the object is there.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { objectExists, readObjectWithin } from "./gcs";

let objects: Map<string, Buffer>;
let failure: Error | undefined;
let ranges: Array<{ bucket: string; name: string; start?: number; end?: number }>;

vi.mock("@google-cloud/storage", () => {
  class FakeStorage {
    bucket(bucketName: string) {
      return {
        file: (name: string) => ({
          async download(options: { start?: number; end?: number }) {
            ranges.push({ bucket: bucketName, name, ...options });
            if (failure) throw failure;
            const bytes = objects.get(name);
            if (!bytes) throw Object.assign(new Error("No such object"), { code: 404 });
            return [bytes.subarray(options.start, options.end === undefined ? undefined : options.end + 1)];
          },
          async exists() {
            if (failure) throw failure;
            return [objects.has(name)];
          },
        }),
      };
    }
  }
  return { Storage: FakeStorage };
});

const forbidden = () => Object.assign(new Error("forbidden"), { code: 403 });

beforeEach(() => {
  objects = new Map();
  failure = undefined;
  ranges = [];
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS_B64", Buffer.from("{}").toString("base64"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readObjectWithin", () => {
  test("returns the bytes, asking for no more than one past the cap", async () => {
    objects.set("a.jpg", Buffer.from("abcd"));
    const bytes = await readObjectWithin("scans", "a.jpg", 10);
    expect(Buffer.from(bytes!).toString()).toBe("abcd");
    expect(ranges).toEqual([{ bucket: "scans", name: "a.jpg", start: 0, end: 10 }]);
  });

  test("an object of exactly the cap is within it", async () => {
    objects.set("a.jpg", Buffer.from("abcd"));
    expect(await readObjectWithin("scans", "a.jpg", 4)).not.toBeNull();
  });

  test("an object over the cap gives null", async () => {
    objects.set("a.jpg", Buffer.from("abcde"));
    expect(await readObjectWithin("scans", "a.jpg", 4)).toBeNull();
  });

  test("a 404 gives null", async () => {
    expect(await readObjectWithin("scans", "missing.jpg", 4)).toBeNull();
  });

  test("a 403 throws: it says nothing about whether the object is there", async () => {
    failure = forbidden();
    await expect(readObjectWithin("scans", "a.jpg", 4)).rejects.toThrow("forbidden");
  });

  test("a failure with no code throws", async () => {
    failure = new Error("socket hang up");
    await expect(readObjectWithin("scans", "a.jpg", 4)).rejects.toThrow("socket hang up");
  });
});

describe("objectExists", () => {
  test("true when the object is there", async () => {
    objects.set("a.jpg", Buffer.from("abcd"));
    expect(await objectExists("scans", "a.jpg")).toBe(true);
  });

  test("false when it is not", async () => {
    expect(await objectExists("scans", "missing.jpg")).toBe(false);
  });

  test("a 403 throws", async () => {
    failure = forbidden();
    await expect(objectExists("scans", "a.jpg")).rejects.toThrow("forbidden");
  });
});
