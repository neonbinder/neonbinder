import { describe, expect, test } from "vitest";
import { scrubSignedStorageUrls } from "./scrub-signed-urls";

const SIGNED_URL =
  "https://storage.googleapis.com/neonbinder-placeholder-uploads-neonbinder-dev/placeholders/user_abc/job-1/input.zip" +
  "?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=svc%40example.iam&X-Goog-Signature=deadbeef1234";

describe("scrubSignedStorageUrls", () => {
  test("strips the query string off a storage.googleapis.com URL, keeping the path", () => {
    const result = scrubSignedStorageUrls({ data: { url: SIGNED_URL } });
    expect(result.data.url).toBe(
      "https://storage.googleapis.com/neonbinder-placeholder-uploads-neonbinder-dev/placeholders/user_abc/job-1/input.zip?<redacted>",
    );
    // The signature must not survive in any form.
    expect(JSON.stringify(result)).not.toContain("deadbeef1234");
    expect(JSON.stringify(result)).not.toContain("X-Goog-Signature");
  });

  test("finds and scrubs the URL no matter how deeply nested (breadcrumb / span / rrweb-frame shapes)", () => {
    const fakeBreadcrumb = {
      category: "xhr",
      data: { method: "PUT", url: SIGNED_URL, status_code: 200 },
    };
    const fakeTransactionEvent = {
      spans: [{ description: "PUT storage.googleapis.com", data: { "http.url": SIGNED_URL } }],
    };
    const fakeReplayFrame = {
      type: 5,
      data: { payload: { requests: [{ url: SIGNED_URL }] } },
    };

    for (const shape of [fakeBreadcrumb, fakeTransactionEvent, fakeReplayFrame]) {
      const scrubbed = JSON.stringify(scrubSignedStorageUrls(shape));
      expect(scrubbed).not.toContain("X-Goog-Signature");
      expect(scrubbed).not.toContain("deadbeef1234");
      expect(scrubbed).toContain("storage.googleapis.com");
      expect(scrubbed).toContain("<redacted>");
    }
  });

  test("leaves other URLs and look-alike parameters untouched, returning the same object", () => {
    const value = { url: "https://example.com/api/thing?page=2&csrf_token=keep&tokens=keep", note: "copy-photos/short/" };
    expect(scrubSignedStorageUrls(value)).toBe(value);
  });

  test("redacts a token query parameter on any host (NEO-434: the old pass left this one alone)", () => {
    const result = scrubSignedStorageUrls({ url: "https://example.com/api/thing?token=x" });
    expect(result).toEqual({ url: "https://example.com/api/thing?token=<redacted>" });
  });

  test("does not touch a JSON key named token", () => {
    const value = { properties: { token: "phc_project_key" } };
    expect(scrubSignedStorageUrls(value)).toBe(value);
  });

  test("is a no-op on values with nothing to redact", () => {
    const value = { message: "hello world", count: 3, nested: { ok: true } };
    expect(scrubSignedStorageUrls(value)).toEqual(value);
  });

  test("handles a bare storage.googleapis.com URL with no query string", () => {
    const value = { url: "https://storage.googleapis.com/bucket/object.zip" };
    expect(scrubSignedStorageUrls(value)).toEqual(value);
  });

  describe("NEO-434: any host, any encoding", () => {
    const TOKEN = "0123456789abcdef0123456789abcdef";

    test.each([
      [
        "an R2 signed PUT: account, token and every X-Amz parameter",
        `https://acct123.r2.cloudflarestorage.com/photos/copy-photos/${TOKEN}/image.jpg?X-Amz-Credential=c1&X-Amz-Signature=s1`,
        "https://<redacted>.r2.cloudflarestorage.com/photos/copy-photos/<redacted>/image.jpg?X-Amz-Credential=<redacted>&X-Amz-Signature=<redacted>",
      ],
      [
        "an R2 host with a bucket and a jurisdiction",
        "https://bucket.acct123.eu.r2.cloudflarestorage.com/o",
        "https://<redacted>.eu.r2.cloudflarestorage.com/o",
      ],
      ["a bare R2 host", "acct123.r2.cloudflarestorage.com", "<redacted>.r2.cloudflarestorage.com"],
      [
        "a Convex one-time upload URL",
        "https://x.convex.cloud/api/storage/upload?token=t1",
        "https://x.convex.cloud/api/storage/upload?token=<redacted>",
      ],
      ["a bare http.query", "?X-Goog-Credential=c1&X-Goog-Signature=s1", "?X-Goog-Credential=<redacted>&X-Goog-Signature=<redacted>"],
      ["a query with no leading ?", "token=t1&a=1", "token=<redacted>&a=1"],
      ["a bucket-host Google URL", "https://b.storage.googleapis.com/o?GoogleAccessId=g&Signature=s1", "https://b.storage.googleapis.com/o?<redacted>"],
      [
        "an encoded signed URL inside another URL",
        "https://a.test/?next=https%3A%2F%2Fb.storage.googleapis.com%2Fo%3FX-Goog-Signature%3Ds1%26X-Goog-Date%3Dd1%26x%3D1",
        "https://a.test/?next=https%3A%2F%2Fb.storage.googleapis.com%2Fo%3FX-Goog-Signature%3D<redacted>%26X-Goog-Date%3D<redacted>%26x%3D1",
      ],
      [
        "an encoded R2 URL",
        `https://a.test/?next=https%3A%2F%2Facct123.r2.cloudflarestorage.com%2Fcopy-photos%2F${TOKEN}%2Fimage.jpg%3Ftoken%3Dt1`,
        "https://a.test/?next=https%3A%2F%2F<redacted>.r2.cloudflarestorage.com%2Fcopy-photos%2F<redacted>%2Fimage.jpg%3Ftoken%3D<redacted>",
      ],
      [
        "a copy-photo read URL",
        `https://x.convex.site/copy-photo/${TOKEN}/thumb`,
        "https://x.convex.site/copy-photo/<redacted>/thumb",
      ],
      ["an object key", `copy-photos/${TOKEN}/image.jpg`, "copy-photos/<redacted>/image.jpg"],
    ])("%s", (_name, input, expected) => {
      expect(scrubSignedStorageUrls({ data: { url: input } })).toEqual({ data: { url: expected } });
    });

    test("a path that only looks like a copy-photo token is left alone", () => {
      const value = { a: `copy-photos/${TOKEN}0/x`, b: `copy-photo/${TOKEN.toUpperCase()}/x` };
      expect(scrubSignedStorageUrls(value)).toBe(value);
    });

    test.each([
      ["a Google URL", 'failed "https://storage.googleapis.com/b/o?X-Goog-Signature=s1" twice'],
      ["an R2 URL", 'failed "https://acct123.r2.cloudflarestorage.com/o?X-Amz-Signature=s1" twice'],
      ["a token URL", 'failed "https://x.convex.cloud/u?token=s1" twice'],
    ])("a double-quoted %s in a message keeps the JSON valid", (_name, message) => {
      const out = scrubSignedStorageUrls({ message });
      expect(out.message).toMatch(/^failed ".*<redacted>" twice$/);
      expect(out.message).not.toContain("s1");
    });
  });

  test("scrubs multiple signed URLs in the same payload independently", () => {
    const other =
      "https://storage.googleapis.com/other-bucket/other/path.zip?X-Goog-Signature=cafebabe0000";
    const value = { first: SIGNED_URL, second: other };
    const result = scrubSignedStorageUrls(value);
    expect(result.first).toBe(
      "https://storage.googleapis.com/neonbinder-placeholder-uploads-neonbinder-dev/placeholders/user_abc/job-1/input.zip?<redacted>",
    );
    expect(result.second).toBe("https://storage.googleapis.com/other-bucket/other/path.zip?<redacted>");
  });
});
