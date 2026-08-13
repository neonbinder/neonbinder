/**
 * Unit tests for `createPlaceholderUploadUrl` (NEO-148).
 *
 * Coverage:
 *  - unauthenticated callers get a thrown error (not a soft {success:false})
 *  - passing ANY argument is rejected — the action's contract is zero args,
 *    and this test is what makes that claim checked rather than merely true
 *    by accident
 *  - a Clerk identity whose subject doesn't match the expected `user_...`
 *    shape is rejected before it can become a path segment
 *  - the returned objectPath is built entirely server-side: it contains the
 *    caller's own Clerk userId and a freshly generated jobId
 *  - the policy is generated with a content-length-range condition capping
 *    the upload, an exact Content-Type field, and a write-once
 *    `x-goog-if-generation-match: 0` field
 *  - GCS_PLACEHOLDER_BUCKET names the bucket, not a hardcoded literal
 *    (unlike the known-broken `gcs.ts` prizes bucket)
 *  - a `placeholderJobs` ownership row is written with the authenticated
 *    caller's userId and the same jobId returned to them — this is the
 *    record downstream (NEO-151/152) functions will check against instead
 *    of ever trusting a client-supplied objectPath
 *
 * Why we mock `@google-cloud/storage` directly: convex-test runs the real
 * action code, and the real `Storage` client would try to read
 * GOOGLE_APPLICATION_CREDENTIALS_B64 and make a network call to sign the
 * policy. Mocking the constructor lets us assert exactly what
 * `generateSignedPostPolicyV4` was called with, and returns a fake
 * url/fields pair synchronously.
 *
 * Filename note: this lives at `convex/adapters.placeholderUploads.test.ts`
 * (dotted, not nested under `convex/adapters/`) to match the repo's
 * existing compound-name convention (e.g. `credentials.instrumentation.test.ts`)
 * — and because convex-test's `import.meta.glob("./**\/*.*s")` module
 * registry only resolves function paths correctly when the test file itself
 * lives at the `convex/` root; the same glob run from inside
 * `convex/adapters/` produces keys convex-test's resolver can't match back
 * to `api.adapters.X`, and every `t.action(...)` call fails with
 * `Could not find module for: "adapters/X"`.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const policyCalls: Array<{ bucket: string; file: string; config: Record<string, unknown> }> = [];

vi.mock("@google-cloud/storage", () => {
  class FakeFile {
    constructor(
      private bucketName: string,
      private fileName: string,
    ) {}
    async generateSignedPostPolicyV4(config: Record<string, unknown>) {
      policyCalls.push({ bucket: this.bucketName, file: this.fileName, config });
      return [
        {
          url: `https://storage.googleapis.com/${this.bucketName}/`,
          fields: {
            key: this.fileName,
            "x-goog-date": "20260813T000000Z",
            "x-goog-credential": "fake@example.iam/20260813/auto/storage/goog4_request",
            "x-goog-algorithm": "GOOG4-RSA-SHA256",
            ...(config.fields as Record<string, string>),
            policy: "fake-base64-policy",
            "x-goog-signature": "fake-signature-hex",
          },
        },
      ];
    }
  }
  class FakeBucket {
    constructor(private name: string) {}
    file(fileName: string) {
      return new FakeFile(this.name, fileName);
    }
  }
  class FakeStorage {
    bucket(name: string) {
      return new FakeBucket(name);
    }
  }
  return { Storage: FakeStorage };
});

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER_IDENTITY = {
  subject: "user_placeholder001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_placeholder001",
  name: "Test User",
};

const OTHER_USER_IDENTITY = {
  subject: "user_placeholder002",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_placeholder002",
  name: "Other User",
};

// A subject that fails CLERK_USER_ID_RE — no plausible Clerk token produces
// this, but a test double, a misconfigured auth provider, or a future
// non-Clerk identity source could.
const MALFORMED_IDENTITY = {
  subject: "../../etc/passwd",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|malformed",
  name: "Malformed",
};

beforeEach(() => {
  policyCalls.length = 0;
  process.env.GOOGLE_APPLICATION_CREDENTIALS_B64 = Buffer.from(
    JSON.stringify({ client_email: "fake@example.com", private_key: "fake" }),
  ).toString("base64");
  process.env.GCS_PLACEHOLDER_BUCKET = "neonbinder-placeholder-uploads-test";
});

afterEach(() => {
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS_B64;
  delete process.env.GCS_PLACEHOLDER_BUCKET;
});

describe("createPlaceholderUploadUrl", () => {
  test("throws when unauthenticated, rather than returning success:false", async () => {
    const t = convexTest(schema, modules);
    await expect(t.action(api.adapters.placeholderUploads.createPlaceholderUploadUrl, {})).rejects.toThrow(
      /not authenticated/i,
    );
  });

  test("rejects any argument — the action's contract is zero client input", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(USER_IDENTITY);
    await expect(
      asUser.action(
        api.adapters.placeholderUploads.createPlaceholderUploadUrl,
        { jobId: "../victim" } as never,
      ),
    ).rejects.toThrow();
    expect(policyCalls).toHaveLength(0);
  });

  test("rejects an identity whose subject doesn't match the expected user_... shape", async () => {
    const t = convexTest(schema, modules);
    const asMalformed = t.withIdentity(MALFORMED_IDENTITY);
    await expect(
      asMalformed.action(api.adapters.placeholderUploads.createPlaceholderUploadUrl, {}),
    ).rejects.toThrow();
    expect(policyCalls).toHaveLength(0);
  });

  test("throws when GCS_PLACEHOLDER_BUCKET is not set", async () => {
    delete process.env.GCS_PLACEHOLDER_BUCKET;
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(USER_IDENTITY);
    await expect(asUser.action(api.adapters.placeholderUploads.createPlaceholderUploadUrl, {})).rejects.toThrow(
      /GCS_PLACEHOLDER_BUCKET/,
    );
  });

  test("builds an object path scoped to the caller's own userId, with a fresh jobId — no client input", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(USER_IDENTITY);

    const result = await asUser.action(api.adapters.placeholderUploads.createPlaceholderUploadUrl, {});

    expect(result.objectPath).toBe(`placeholders/${USER_IDENTITY.subject}/${result.jobId}/input.zip`);
    // UUID-shaped jobId, generated server-side.
    expect(result.jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test("writes a placeholderJobs ownership row with the authenticated user's id and the returned jobId", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(USER_IDENTITY);

    const result = await asUser.action(api.adapters.placeholderUploads.createPlaceholderUploadUrl, {});

    const rows = await t.run(async (ctx) => ctx.db.query("placeholderJobs").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].jobId).toBe(result.jobId);
    expect(rows[0].userId).toBe(USER_IDENTITY.subject);
    expect(rows[0].objectPath).toBe(result.objectPath);
    expect(rows[0].status).toBe("pending");
  });

  test("two different users get object paths scoped to their own identity, never each other's", async () => {
    const t = convexTest(schema, modules);

    const resultA = await t
      .withIdentity(USER_IDENTITY)
      .action(api.adapters.placeholderUploads.createPlaceholderUploadUrl, {});
    const resultB = await t
      .withIdentity(OTHER_USER_IDENTITY)
      .action(api.adapters.placeholderUploads.createPlaceholderUploadUrl, {});

    expect(resultA.objectPath.startsWith(`placeholders/${USER_IDENTITY.subject}/`)).toBe(true);
    expect(resultB.objectPath.startsWith(`placeholders/${OTHER_USER_IDENTITY.subject}/`)).toBe(true);
    expect(resultA.objectPath).not.toBe(resultB.objectPath);
    expect(resultA.jobId).not.toBe(resultB.jobId);
  });

  test("generates the policy with a content-length-range cap, exact Content-Type, and write-once generation-match", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(USER_IDENTITY);

    const before = Date.now();
    const result = await asUser.action(api.adapters.placeholderUploads.createPlaceholderUploadUrl, {});
    const after = Date.now();

    expect(policyCalls).toHaveLength(1);
    const call = policyCalls[0];
    expect(call.bucket).toBe("neonbinder-placeholder-uploads-test");
    expect(call.file).toBe(result.objectPath);

    expect(call.config.fields).toMatchObject({
      "Content-Type": "application/zip",
      "x-goog-if-generation-match": "0",
    });
    expect(call.config.conditions).toEqual([["content-length-range", 0, result.maxUploadBytes]]);
    expect(result.maxUploadBytes).toBeGreaterThan(0);

    const FIFTEEN_MIN_MS = 15 * 60 * 1000;
    expect(call.config.expires).toBeGreaterThanOrEqual(before + FIFTEEN_MIN_MS - 1000);
    expect(call.config.expires).toBeLessThanOrEqual(after + FIFTEEN_MIN_MS + 1000);
    expect(result.expiresAt).toBe(call.config.expires);
  });

  test("returns the fake policy url/fields from the mocked client", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity(USER_IDENTITY);

    const result = await asUser.action(api.adapters.placeholderUploads.createPlaceholderUploadUrl, {});

    expect(result.uploadUrl).toBe("https://storage.googleapis.com/neonbinder-placeholder-uploads-test/");
    expect(result.fields.key).toBe(result.objectPath);
    expect(result.fields["Content-Type"]).toBe("application/zip");
    expect(result.fields["x-goog-if-generation-match"]).toBe("0");
  });
});
