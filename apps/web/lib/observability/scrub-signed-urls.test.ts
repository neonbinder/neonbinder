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
        "a virtual-hosted R2 signed PUT (NEO-466): bucket and account in the host, no bucket in the path",
        `https://photos.acct123.r2.cloudflarestorage.com/copy-photos/${TOKEN}/image.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=c1&X-Amz-Date=d1&X-Amz-Expires=600&X-Amz-SignedHeaders=host&X-Amz-Signature=s1`,
        "https://<redacted>.r2.cloudflarestorage.com/copy-photos/<redacted>/image.jpg?X-Amz-Algorithm=<redacted>&X-Amz-Credential=<redacted>&X-Amz-Date=<redacted>&X-Amz-Expires=<redacted>&X-Amz-SignedHeaders=<redacted>&X-Amz-Signature=<redacted>",
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

    test("a virtual-hosted R2 PUT URL is scrubbed in a breadcrumb, a span and a message (NEO-466)", () => {
      const url = `https://photos.acct123.r2.cloudflarestorage.com/copy-photos/${TOKEN}/image.jpg?X-Amz-Credential=c1&X-Amz-Signature=s1`;
      const shapes = [
        { category: "xhr", data: { method: "PUT", url, status_code: 200 } },
        { spans: [{ description: "PUT photos.acct123.r2.cloudflarestorage.com", data: { "http.url": url } }] },
        { message: `upload to ${url} stalled` },
      ];
      for (const shape of shapes) {
        const scrubbed = JSON.stringify(scrubSignedStorageUrls(shape));
        for (const secret of ["acct123", "photos.", TOKEN, "c1", "s1\""]) expect(scrubbed).not.toContain(secret);
        expect(scrubbed).toContain("<redacted>.r2.cloudflarestorage.com");
      }
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

  describe("JSON escapes (NEO-434 re-audit)", () => {
    test("a bare R2 host right after an escape is redacted and the JSON still parses", () => {
      expect(scrubSignedStorageUrls({ m: "upload refused\nacct123.r2.cloudflarestorage.com" })).toEqual({
        m: "upload refused\n<redacted>.r2.cloudflarestorage.com",
      });
      expect(scrubSignedStorageUrls({ m: "\u0001acct123.r2.cloudflarestorage.com" })).toEqual({
        m: "\u0001<redacted>.r2.cloudflarestorage.com",
      });
    });

    test.each(["\n", "\t", "\r", "\b", "\f", "\u0001", "\\u0026", "\\n", "%26", "%3F"])(
      "a parameter right after %j is redacted, plain and percent-encoded",
      (before) => {
        const plain = JSON.stringify(
          scrubSignedStorageUrls({ m: `bad${before}token=SECRET1${before}X-Amz-Signature=SECRET2${before}x-goog-signature=SECRET3` }),
        );
        for (const secret of ["SECRET1", "SECRET2", "SECRET3"]) expect(plain).not.toContain(secret);
        const encoded = JSON.stringify(scrubSignedStorageUrls({ m: `bad${before}token%3DSECRET4` }));
        expect(encoded).not.toContain("SECRET4");
      },
    );

    test("look-alike names are still left alone", () => {
      const value = { m: "csrf_token=keep my-token=keep xtoken=keep" };
      expect(scrubSignedStorageUrls(value)).toBe(value);
    });

    test("no mix of escapes and shapes breaks the JSON or changes the shape", () => {
      const pieces = [
        "\n", "\t", "\r", "\b", "\f", "\u0001", "\u001f", "\ud83d", '"', "\\", "\\u0026", "'", " ", "&", "?", "#", "%", "%2F", "%26", "%3F", "%3D",
        "a", "n", "u", "0", "acct.", "token=", "token%3D", "X-Goog-Signature=", "x-amz-signature%3D", "VAL",
        "r2.cloudflarestorage.com", ".eu.r2.cloudflarestorage.com", "https://storage.googleapis.com/b/o?", "copy-photo/", "0123456789abcdef0123456789abcdef",
        "/api/storage/", "%2Fapi%2Fstorage%2F", "upload",
      ];
      // Every ordered triple, so a failure names the string that reproduces it.
      for (const first of pieces) {
        for (const second of pieces) {
          for (const third of pieces) {
            const m = first + second + third;
            let scrubbed: { m: unknown; n: number } | undefined;
            try {
              scrubbed = scrubSignedStorageUrls({ m, n: 1 });
            } catch {
              expect.unreachable(`broke the JSON: ${JSON.stringify(m)}`);
            }
            if (typeof scrubbed?.m !== "string" || scrubbed.n !== 1) expect.unreachable(`changed the shape: ${JSON.stringify(m)}`);
          }
        }
      }
    });
  });

  describe("Convex storage read URLs (NEO-434 re-audit)", () => {
    const ID = "kg2abc00storageid99";

    test("the id goes, plain and percent-encoded, wherever it sits", () => {
      expect(scrubSignedStorageUrls({ u: `https://dep.convex.cloud/api/storage/${ID}` })).toEqual({
        u: "https://dep.convex.cloud/api/storage/<redacted>",
      });
      for (const text of [
        `<img src="https://dep.convex.cloud/api/storage/${ID}">`,
        `GET /api/storage/${ID}?x=1 failed`,
        `next=https%3A%2F%2Fdep.convex.cloud%2Fapi%2Fstorage%2F${ID}`,
        `line\n/api/storage/${ID}`,
      ]) {
        expect(JSON.stringify(scrubSignedStorageUrls({ text }))).not.toContain(ID);
      }
    });

    test("the upload endpoint keeps its name and loses its token", () => {
      expect(scrubSignedStorageUrls({ u: "https://dep.convex.site/api/storage/upload?token=T1" })).toEqual({
        u: "https://dep.convex.site/api/storage/upload?token=<redacted>",
      });
      const value = { m: "POST /api/storage/upload failed" };
      expect(scrubSignedStorageUrls(value)).toBe(value);
    });

    test("an id that starts with the word upload still goes", () => {
      expect(scrubSignedStorageUrls({ u: "/api/storage/upload9a" })).toEqual({ u: "/api/storage/<redacted>" });
    });
  });

  test("a large payload with no secret stays cheap, including a run of host-like labels", () => {
    const value = { m: "abc.".repeat(250_000), o: "https://x/".repeat(50_000) };
    const start = performance.now();
    expect(scrubSignedStorageUrls(value)).toBe(value);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
