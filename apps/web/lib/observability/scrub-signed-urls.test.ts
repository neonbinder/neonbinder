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

  test("leaves non-storage URLs untouched", () => {
    const value = { url: "https://example.com/api/thing?token=super-secret" };
    expect(scrubSignedStorageUrls(value)).toEqual(value);
  });

  test("is a no-op on values with no storage.googleapis.com substring at all", () => {
    const value = { message: "hello world", count: 3, nested: { ok: true } };
    expect(scrubSignedStorageUrls(value)).toEqual(value);
  });

  test("handles a bare storage.googleapis.com URL with no query string", () => {
    const value = { url: "https://storage.googleapis.com/bucket/object.zip" };
    expect(scrubSignedStorageUrls(value)).toEqual(value);
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
