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

/**
 * Object keys the fake bucket claims to hold. `exists()` answers from this set,
 * which is what lets the download tests drive the output-extension probe — the
 * one piece of `createPlaceholderImageDownloadUrl` that talks to storage before
 * it signs anything.
 */
const existingObjects = new Set<string>();

/** Every `getSignedUrl` call, for asserting the key and the read config. */
const signedUrlCalls: Array<{ bucket: string; file: string; config: Record<string, unknown> }> =
  [];

/** Every `exists()` probe, in order — the probe order is part of the contract. */
const existsProbes: string[] = [];

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
    async exists() {
      existsProbes.push(this.fileName);
      return [existingObjects.has(this.fileName)];
    }
    async getSignedUrl(config: Record<string, unknown>) {
      signedUrlCalls.push({ bucket: this.bucketName, file: this.fileName, config });
      return [
        `https://storage.googleapis.com/${this.bucketName}/${this.fileName}?x-goog-signature=fake`,
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
  signedUrlCalls.length = 0;
  existsProbes.length = 0;
  existingObjects.clear();
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

// ---------------------------------------------------------------------------
// createPlaceholderImageUploadUrl — the per-image policy for streaming intake
// ---------------------------------------------------------------------------

/** Open a scanner session as USER_IDENTITY and return its jobId. */
async function openStream(t: ReturnType<typeof convexTest>): Promise<string> {
  const result = await t
    .withIdentity(USER_IDENTITY)
    .mutation(api.placeholderStream.startPlaceholderStream, {});
  expect(result.started).toBe(true);
  return result.jobId!;
}

describe("createPlaceholderImageUploadUrl", () => {
  test("throws when unauthenticated, before touching the job", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);
    await expect(
      t.action(api.adapters.placeholderUploads.createPlaceholderImageUploadUrl, {
        jobId,
        contentType: "image/jpeg",
      }),
    ).rejects.toThrow(/not authenticated/i);
    expect(policyCalls).toHaveLength(0);
  });

  test("signs a policy for a server-derived extracted/ key, scoped to the caller", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);

    const before = Date.now();
    const result = await t
      .withIdentity(USER_IDENTITY)
      .action(api.adapters.placeholderUploads.createPlaceholderImageUploadUrl, {
        jobId,
        contentType: "image/jpeg",
        originalName: "front.jpg",
      });
    const after = Date.now();

    expect(result.entryIndex).toBe(0);
    // The key is where /extract would have written in zip mode — that is what
    // makes /process-entry able to find it without knowing which path produced
    // it — with the same 4-digit zero padding the service's layout uses.
    expect(policyCalls).toHaveLength(1);
    expect(policyCalls[0].file).toBe(
      `placeholders/${USER_IDENTITY.subject}/${jobId}/extracted/0000.jpg`,
    );
    expect(result.fields.key).toBe(policyCalls[0].file);

    // The three server-side bounds, all mirrored from the preprocess service.
    expect(policyCalls[0].config.fields).toMatchObject({
      "Content-Type": "image/jpeg",
      "x-goog-if-generation-match": "0",
    });
    expect(policyCalls[0].config.conditions).toEqual([
      ["content-length-range", 0, 32 * 1024 * 1024],
    ]);
    expect(result.maxUploadBytes).toBe(32 * 1024 * 1024);

    const FIVE_MIN_MS = 5 * 60 * 1000;
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + FIVE_MIN_MS - 1000);
    expect(result.expiresAt).toBeLessThanOrEqual(after + FIVE_MIN_MS + 1000);

    // No structured copy of the path: the key already travels inside `fields`,
    // and a second one is what future callers would start passing around.
    expect(result).not.toHaveProperty("objectPath");
  });

  test("each call claims the next index, so two uploads never collide", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);
    const asUser = t.withIdentity(USER_IDENTITY);

    const first = await asUser.action(
      api.adapters.placeholderUploads.createPlaceholderImageUploadUrl,
      { jobId, contentType: "image/jpeg" },
    );
    const second = await asUser.action(
      api.adapters.placeholderUploads.createPlaceholderImageUploadUrl,
      { jobId, contentType: "image/png" },
    );

    expect([first.entryIndex, second.entryIndex]).toEqual([0, 1]);
    expect(policyCalls.map((c) => c.file)).toEqual([
      `placeholders/${USER_IDENTITY.subject}/${jobId}/extracted/0000.jpg`,
      `placeholders/${USER_IDENTITY.subject}/${jobId}/extracted/0001.png`,
    ]);
  });

  test("refuses a content type the service would not accept, without consuming an index", async () => {
    // The allowlist is exact rather than parameter-tolerant because the value is
    // signed into the policy's Content-Type condition, which GCS compares
    // byte-for-byte.
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);
    const asUser = t.withIdentity(USER_IDENTITY);

    for (const contentType of ["application/pdf", "image/gif", "image/jpeg; charset=binary", ""]) {
      await expect(
        asUser.action(api.adapters.placeholderUploads.createPlaceholderImageUploadUrl, {
          jobId,
          contentType,
        }),
      ).rejects.toThrow(/unsupported image type/i);
    }

    expect(policyCalls).toHaveLength(0);
    // A refused mint must not have burned an entry index — the next real one is
    // still 0.
    const ok = await asUser.action(
      api.adapters.placeholderUploads.createPlaceholderImageUploadUrl,
      { jobId, contentType: "image/webp" },
    );
    expect(ok.entryIndex).toBe(0);
  });

  test("another user cannot mint into someone else's session, or into a job that doesn't exist", async () => {
    const t = convexTest(schema, modules);
    const jobId = await openStream(t);
    const asOther = t.withIdentity(OTHER_USER_IDENTITY);

    await expect(
      asOther.action(api.adapters.placeholderUploads.createPlaceholderImageUploadUrl, {
        jobId,
        contentType: "image/jpeg",
      }),
    ).rejects.toThrow(/job not found/i);
    await expect(
      asOther.action(api.adapters.placeholderUploads.createPlaceholderImageUploadUrl, {
        jobId: "not-a-job",
        contentType: "image/jpeg",
      }),
    ).rejects.toThrow(/job not found/i);

    expect(policyCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createPlaceholderImageDownloadUrl — reading a processed crop back
// ---------------------------------------------------------------------------

const DOWNLOAD_JOB = "11111111-2222-4333-8444-555555555555";

/**
 * A job plus one image row, in whatever state the test needs. Inserted directly
 * because the states worth testing here ("done", "processing") are produced by
 * the pool, which convex-test cannot mount.
 */
async function seedDownloadable(
  t: ReturnType<typeof convexTest>,
  opts: {
    status?: "awaiting_upload" | "queued" | "processing" | "done" | "failed";
    entryIndex?: number;
    userId?: string;
    outputExtension?: string;
  } = {},
) {
  const userId = opts.userId ?? USER_IDENTITY.subject;
  const entryIndex = opts.entryIndex ?? 7;
  await t.run(async (ctx) => {
    await ctx.db.insert("placeholderJobs", {
      jobId: DOWNLOAD_JOB,
      userId,
      objectPath: `placeholders/${userId}/${DOWNLOAD_JOB}/`,
      createdAt: 1_700_000_000_000,
      status: "succeeded",
    });
    await ctx.db.insert("placeholderImages", {
      jobId: DOWNLOAD_JOB,
      userId,
      entryIndex,
      originalName: "front.jpg",
      status: opts.status ?? "done",
      ...(opts.outputExtension ? { outputExtension: opts.outputExtension } : {}),
    });
  });
  return { userId, entryIndex };
}

function outputKey(userId: string, entryIndex: number, extension: string): string {
  return `placeholders/${userId}/${DOWNLOAD_JOB}/output/images/${String(entryIndex).padStart(4, "0")}.${extension}`;
}

describe("createPlaceholderImageDownloadUrl", () => {
  test("throws when unauthenticated", async () => {
    const t = convexTest(schema, modules);
    await seedDownloadable(t);
    await expect(
      t.action(api.adapters.placeholderUploads.createPlaceholderImageDownloadUrl, {
        jobId: DOWNLOAD_JOB,
        entryIndex: 7,
      }),
    ).rejects.toThrow(/not authenticated/i);
    expect(signedUrlCalls).toHaveLength(0);
  });

  test("signs a read url for the output object, probing the service's extensions in order", async () => {
    const t = convexTest(schema, modules);
    const { userId, entryIndex } = await seedDownloadable(t);
    existingObjects.add(outputKey(userId, entryIndex, "png"));

    const before = Date.now();
    const result = await t
      .withIdentity(USER_IDENTITY)
      .action(api.adapters.placeholderUploads.createPlaceholderImageDownloadUrl, {
        jobId: DOWNLOAD_JOB,
        entryIndex,
      });
    const after = Date.now();

    // jpg first, then png — the same order the service uses to find an object
    // whose extension it does not know, and it stops as soon as one hits.
    expect(existsProbes).toEqual([
      outputKey(userId, entryIndex, "jpg"),
      outputKey(userId, entryIndex, "png"),
    ]);

    expect(signedUrlCalls).toHaveLength(1);
    expect(signedUrlCalls[0].file).toBe(outputKey(userId, entryIndex, "png"));
    expect(signedUrlCalls[0].config).toMatchObject({ version: "v4", action: "read" });
    expect(result.url).toContain(outputKey(userId, entryIndex, "png"));
    expect(result.entryIndex).toBe(entryIndex);

    const FIFTEEN_MIN_MS = 15 * 60 * 1000;
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + FIFTEEN_MIN_MS - 1000);
    expect(result.expiresAt).toBeLessThanOrEqual(after + FIFTEEN_MIN_MS + 1000);
    expect(signedUrlCalls[0].config.expires).toBe(result.expiresAt);

    // Neither the bucket nor a structured copy of the key comes back — the url
    // is the only thing that carries them, and it has to.
    expect(result).not.toHaveProperty("objectPath");
    expect(result).not.toHaveProperty("bucket");
    expect(Object.keys(result).sort()).toEqual(["entryIndex", "expiresAt", "url"]);
  });

  test("memoises the extension, so a second mint probes once", async () => {
    // The review UI mints one of these per image on every render; three HEADs
    // per image per render is the cost this cache exists to remove.
    const t = convexTest(schema, modules);
    const { userId, entryIndex } = await seedDownloadable(t);
    existingObjects.add(outputKey(userId, entryIndex, "webp"));
    const asUser = t.withIdentity(USER_IDENTITY);

    await asUser.action(api.adapters.placeholderUploads.createPlaceholderImageDownloadUrl, {
      jobId: DOWNLOAD_JOB,
      entryIndex,
    });
    expect(existsProbes).toHaveLength(3);

    const stored = await t.run(async (ctx) => {
      const rows = await ctx.db.query("placeholderImages").collect();
      return rows[0].outputExtension;
    });
    expect(stored).toBe("webp");

    existsProbes.length = 0;
    await asUser.action(api.adapters.placeholderUploads.createPlaceholderImageDownloadUrl, {
      jobId: DOWNLOAD_JOB,
      entryIndex,
    });
    expect(existsProbes).toEqual([outputKey(userId, entryIndex, "webp")]);
  });

  test("ignores a memoised extension that is not one the service can have written", async () => {
    // The column can only have been written from the allowlist, so this should
    // be unreachable — but a stored string that becomes a path segment is
    // re-checked on the way out rather than trusted for where it came from.
    const t = convexTest(schema, modules);
    const { userId, entryIndex } = await seedDownloadable(t, {
      outputExtension: "../../../etc/passwd",
    });
    existingObjects.add(outputKey(userId, entryIndex, "jpg"));

    const result = await t
      .withIdentity(USER_IDENTITY)
      .action(api.adapters.placeholderUploads.createPlaceholderImageDownloadUrl, {
        jobId: DOWNLOAD_JOB,
        entryIndex,
      });

    expect(existsProbes[0]).toBe(outputKey(userId, entryIndex, "jpg"));
    expect(existsProbes.every((p) => !p.includes(".."))).toBe(true);
    expect(result.url).toContain(outputKey(userId, entryIndex, "jpg"));
  });

  test.each([
    ["a job the caller does not own", OTHER_USER_IDENTITY, 7],
    ["an entry index that does not exist", USER_IDENTITY, 99],
  ] as const)("answers 'Image not found' for %s", async (_label, identity, entryIndex) => {
    const t = convexTest(schema, modules);
    const seeded = await seedDownloadable(t);
    existingObjects.add(outputKey(seeded.userId, seeded.entryIndex, "jpg"));

    await expect(
      t
        .withIdentity(identity)
        .action(api.adapters.placeholderUploads.createPlaceholderImageDownloadUrl, {
          jobId: DOWNLOAD_JOB,
          entryIndex,
        }),
    ).rejects.toThrow(/image not found/i);
    // Nothing was signed, and nothing was probed — so the refusal cannot be
    // told apart from the others by timing a storage round trip either.
    expect(signedUrlCalls).toHaveLength(0);
    expect(existsProbes).toHaveLength(0);
  });

  test("answers 'Image not found' for a job that does not exist at all", async () => {
    // Identical to the unowned case: a distinguishable answer would make this an
    // existence oracle for other users' job ids.
    const t = convexTest(schema, modules);
    await expect(
      t
        .withIdentity(USER_IDENTITY)
        .action(api.adapters.placeholderUploads.createPlaceholderImageDownloadUrl, {
          jobId: DOWNLOAD_JOB,
          entryIndex: 7,
        }),
    ).rejects.toThrow(/image not found/i);
  });

  test.each(["awaiting_upload", "queued", "processing", "failed"] as const)(
    "answers 'Image not found' for a %s image, whose output was never written",
    async (status) => {
      const t = convexTest(schema, modules);
      const { userId, entryIndex } = await seedDownloadable(t, { status });
      // Even if an object somehow sits at the key, a non-done row does not get a
      // url — the row's status is what says an output exists.
      existingObjects.add(outputKey(userId, entryIndex, "jpg"));

      await expect(
        t
          .withIdentity(USER_IDENTITY)
          .action(api.adapters.placeholderUploads.createPlaceholderImageDownloadUrl, {
            jobId: DOWNLOAD_JOB,
            entryIndex,
          }),
      ).rejects.toThrow(/image not found/i);
      expect(signedUrlCalls).toHaveLength(0);
    },
  );

  test("answers 'Image not found' when the row says done but the object is gone", async () => {
    const t = convexTest(schema, modules);
    await seedDownloadable(t);

    await expect(
      t
        .withIdentity(USER_IDENTITY)
        .action(api.adapters.placeholderUploads.createPlaceholderImageDownloadUrl, {
          jobId: DOWNLOAD_JOB,
          entryIndex: 7,
        }),
    ).rejects.toThrow(/image not found/i);
    // All three were tried before giving up.
    expect(existsProbes).toHaveLength(3);
    expect(signedUrlCalls).toHaveLength(0);
  });

  test("throws when GCS_PLACEHOLDER_BUCKET is not set", async () => {
    delete process.env.GCS_PLACEHOLDER_BUCKET;
    const t = convexTest(schema, modules);
    await seedDownloadable(t);
    await expect(
      t
        .withIdentity(USER_IDENTITY)
        .action(api.adapters.placeholderUploads.createPlaceholderImageDownloadUrl, {
          jobId: DOWNLOAD_JOB,
          entryIndex: 7,
        }),
    ).rejects.toThrow(/GCS_PLACEHOLDER_BUCKET/);
  });
});
