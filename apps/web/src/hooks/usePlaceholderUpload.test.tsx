/**
 * NEO-446 — the real `usePlaceholderUpload` hook, with only Convex and the
 * storage POST stood in: which path a selection takes is reported as `kind`, and
 * an oversize zip is refused with the limit it broke.
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fns: {} as Record<string, ReturnType<typeof vi.fn>>,
  post: vi.fn(),
}));

vi.mock("@/convex/_generated/api", () => ({
  api: new Proxy({}, {
    get: (_t, mod: string) =>
      new Proxy({}, {
        get: (_u, fn: string) =>
          mod === "adapters" ? new Proxy({}, { get: (_v, inner: string) => `${fn}.${inner}` }) : `${mod}.${fn}`,
      }),
  }),
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: string) => mocks.fns[ref],
  useAction: (ref: string) => mocks.fns[ref],
}));
// Only the network POST is replaced; the ordering in runPlaceholderUpload is real.
vi.mock("@/lib/placeholders/upload-run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/placeholders/upload-run")>();
  return { ...actual, postSignedForm: (...args: unknown[]) => mocks.post(...args) };
});

import { usePlaceholderUpload } from "./usePlaceholderUpload";

const LIMIT_BYTES = 2 * 1024 * 1024;
const zipFile = (bytes = 10) => new File([new Uint8Array(bytes)], "cards.zip", { type: "application/zip" });
const photo = (name: string) => new File(["x"], name, { type: "image/jpeg" });

beforeEach(() => {
  mocks.post.mockReset().mockResolvedValue(undefined);
  mocks.fns = {
    "placeholderUploads.createPlaceholderUploadUrl": vi.fn(async () => ({
      jobId: "job-zip",
      uploadUrl: "https://storage.example/zip",
      fields: { key: "k" },
      maxUploadBytes: LIMIT_BYTES,
    })),
    "placeholderPipeline.startPlaceholderBatch": vi.fn(async () => ({ started: true })),
    "placeholderStream.startPlaceholderStream": vi.fn(async () => ({ started: true, jobId: "job-stream" })),
    "placeholderStream.confirmPlaceholderImageUpload": vi.fn(async () => ({ confirmed: true })),
    "placeholderUploads.createPlaceholderImageUploadUrl": vi.fn(async () => ({
      uploadUrl: "https://storage.example/img",
      fields: { key: "k" },
      entryIndex: 0,
      expiresAt: Date.now() + 900_000,
      maxUploadBytes: LIMIT_BYTES,
    })),
  };
});

const run = async (files: File[], options?: Parameters<ReturnType<typeof usePlaceholderUpload>["upload"]>[1]) => {
  const { result } = renderHook(() => usePlaceholderUpload());
  let outcome!: Awaited<ReturnType<typeof result.current.upload>>;
  await act(async () => {
    outcome = await result.current.upload(files, options);
  });
  return { outcome, result };
};

describe("usePlaceholderUpload outcome kind (NEO-446)", () => {
  it("a zip comes back as kind zip, counting the archive", async () => {
    const { outcome } = await run([zipFile()], { source: "web" });
    expect(outcome).toEqual({ ok: true, jobId: "job-zip", kind: "zip", uploaded: 1, failed: 0, total: 1 });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.fns["placeholderPipeline.startPlaceholderBatch"]).toHaveBeenCalledWith({ jobId: "job-zip", source: "web" });
  });

  it("an image pick comes back as kind images, with the files' counts", async () => {
    const { outcome } = await run([photo("a.jpg"), photo("b.jpg")], { source: "web" });
    expect(outcome).toEqual({ ok: true, jobId: "job-stream", kind: "images", uploaded: 2, failed: 0, total: 2 });
  });

  it("photos added to an open run are kind images too", async () => {
    const { outcome } = await run([photo("a.jpg")], { jobId: "job-open" });
    expect(outcome).toMatchObject({ ok: true, jobId: "job-open", kind: "images", uploaded: 1 });
    expect(mocks.fns["placeholderStream.startPlaceholderStream"]).not.toHaveBeenCalled();
  });

  it("an oversize zip is refused with the limit in MB, and nothing is posted or started", async () => {
    const { outcome, result } = await run([zipFile(LIMIT_BYTES + 1)]);
    expect(outcome).toEqual({ ok: false, reason: "that zip is larger than the 2MB limit", overLimitMb: 2 });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.fns["placeholderPipeline.startPlaceholderBatch"]).not.toHaveBeenCalled();
    expect(result.current.uploading).toBe(false);
    expect(result.current.progress[0]).toMatchObject({ state: "failed", error: "too large" });
  });

  it("a zip exactly at the limit goes through", async () => {
    const { outcome } = await run([zipFile(LIMIT_BYTES)]);
    expect(outcome).toMatchObject({ ok: true, kind: "zip" });
  });

  it("a refused start carries no kind", async () => {
    mocks.fns["placeholderPipeline.startPlaceholderBatch"] = vi.fn(async () => ({ started: false, reason: "too many batches" }));
    const { outcome } = await run([zipFile()]);
    expect(outcome).toEqual({ ok: false, reason: "too many batches" });
  });

  it("a zip onto an open run, and an empty pick, are refused", async () => {
    expect((await run([zipFile()], { jobId: "job-open" })).outcome).toMatchObject({ ok: false });
    expect((await run([])).outcome).toEqual({ ok: false, reason: "no files to upload" });
  });
});
