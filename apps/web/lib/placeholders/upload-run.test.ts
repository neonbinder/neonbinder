/**
 * NEO-170 — the upload loop's ordering guarantees.
 *
 * Everything asserted here is invisible at runtime. A concurrent version of this
 * loop uploads the same bytes, reports the same "12 uploaded", and produces a
 * deck paired in whatever order the network happened to resolve — the failure
 * shows up much later, as a printed placeholder with the wrong back. So the
 * order of the CALLS is the contract, and these cases read it directly.
 *
 * Lives under `lib/` because two screens share the loop — the placeholder
 * upload screen and the Add cards picker — and because there is nothing React
 * about it. That also puts it in the node-environment Vitest project, which is
 * fine: `File` and `FormData` are globals in Node 20+, and `fetch` is injected
 * rather than called.
 */

import { describe, expect, it, vi } from "vitest";
import { batchNotCollecting } from "@/convex/lib/placeholderRefusals";
import {
  runPlaceholderUpload,
  type FileProgress,
  type UploadRunDeps,
  type UploadTicket,
} from "./upload-run";

function fakeFile(name: string, size = 1024): File {
  // happy-dom implements File; `size` is derived from the parts, so a string of
  // the right length stands in for real bytes.
  return new File(["x".repeat(size)], name, { type: "image/jpeg" });
}

function ticketFor(entryIndex: number): UploadTicket {
  return {
    uploadUrl: "https://storage.example/placeholder-bucket",
    fields: { key: `entry-${entryIndex}`, policy: "signed" },
    entryIndex,
    expiresAt: Date.now() + 900_000,
    maxUploadBytes: 25 * 1024 * 1024,
  };
}

/** Records every call across the three deps in one ordered log. */
function harness(overrides: Partial<UploadRunDeps> = {}) {
  const calls: string[] = [];
  const progress: FileProgress[] = [];
  let nextIndex = 0;

  const deps: UploadRunDeps = {
    createUploadUrl: vi.fn(async ({ originalName }) => {
      const ticket = ticketFor(nextIndex);
      nextIndex += 1;
      calls.push(`allocate:${originalName}:${ticket.entryIndex}`);
      return ticket;
    }),
    postToStorage: vi.fn(async (ticket, file) => {
      calls.push(`post:${file.name}:${ticket.entryIndex}`);
    }),
    confirmUpload: vi.fn(async ({ entryIndex }) => {
      calls.push(`confirm:${entryIndex}`);
      return { confirmed: true, alreadyConfirmed: false, totalImages: entryIndex + 1 };
    }),
    onProgress: (update) => progress.push(update),
    ...overrides,
  };

  return { deps, calls, progress };
}

describe("runPlaceholderUpload", () => {
  it("allocates entry indexes in selection order", async () => {
    const { deps, calls } = harness();
    await runPlaceholderUpload(
      "job-1",
      [fakeFile("front-1.jpg"), fakeFile("back-1.jpg"), fakeFile("front-2.jpg")],
      deps,
    );

    // Adjacency pairing reads entry 0 and 1 as one card. If allocation ever
    // interleaves, this is the assertion that catches it.
    expect(calls.filter((c) => c.startsWith("allocate:"))).toEqual([
      "allocate:front-1.jpg:0",
      "allocate:back-1.jpg:1",
      "allocate:front-2.jpg:2",
    ]);
  });

  it("finishes one file completely before starting the next", async () => {
    const { deps, calls } = harness();
    await runPlaceholderUpload("job-1", [fakeFile("a.jpg"), fakeFile("b.jpg")], deps);

    expect(calls).toEqual([
      "allocate:a.jpg:0",
      "post:a.jpg:0",
      "confirm:0",
      "allocate:b.jpg:1",
      "post:b.jpg:1",
      "confirm:1",
    ]);
  });

  it("confirms only after the bytes have landed", async () => {
    const order: string[] = [];
    const { deps } = harness({
      postToStorage: vi.fn(async () => {
        // A POST that resolves on a later tick — confirm must still wait for it,
        // or the entry is enqueued against an object that is not there.
        await new Promise((resolve) => setTimeout(resolve, 0));
        order.push("post");
      }),
      confirmUpload: vi.fn(async () => {
        order.push("confirm");
        return { confirmed: true, alreadyConfirmed: false, totalImages: 1 };
      }),
    });

    await runPlaceholderUpload("job-1", [fakeFile("a.jpg")], deps);
    expect(order).toEqual(["post", "confirm"]);
  });

  it("keeps going after one file fails, and never confirms it", async () => {
    const { deps, calls, progress } = harness({
      postToStorage: vi.fn(async (ticket, file) => {
        if (file.name === "bad.jpg") throw new Error("Storage rejected the upload (HTTP 403)");
        calls.push(`post:${file.name}:${ticket.entryIndex}`);
      }),
    });

    const result = await runPlaceholderUpload(
      "job-1",
      [fakeFile("bad.jpg"), fakeFile("good.jpg")],
      deps,
    );

    expect(result).toEqual({ uploaded: 1, failed: 1 });
    // The failed entry is never confirmed — it stays `awaiting_upload` and the
    // idle sweep reclaims it. Confirming it would enqueue work against bytes
    // that were never written.
    expect(calls).not.toContain("confirm:0");
    expect(calls).toContain("confirm:1");
    expect(
      progress.find((p) => p.name === "bad.jpg" && p.state === "failed")?.error,
    ).toBe("Storage rejected the upload (HTTP 403)");
  });

  it("rejects an oversized file before spending an upload on it", async () => {
    const { deps, calls } = harness({
      createUploadUrl: vi.fn(async () => ({ ...ticketFor(0), maxUploadBytes: 512 })),
    });

    const result = await runPlaceholderUpload("job-1", [fakeFile("huge.jpg", 2048)], deps);

    expect(result).toEqual({ uploaded: 0, failed: 1 });
    // GCS would reject it too, with an XML 400 that reads as "something went
    // wrong" rather than "this file is too big".
    expect(calls.some((c) => c.startsWith("post:"))).toBe(false);
    expect(deps.confirmUpload).not.toHaveBeenCalled();
  });

  describe("NEO-529: the session stops collecting part-way", () => {
    it("stops at the refused file, fails it and every one after it, and says the batch closed", async () => {
      let allocations = 0;
      const { deps, calls, progress } = harness({
        createUploadUrl: vi.fn(async ({ originalName }) => {
          allocations += 1;
          if (allocations === 2) throw batchNotCollecting("processing");
          calls.push(`allocate:${originalName}:${allocations - 1}`);
          return ticketFor(allocations - 1);
        }),
      });

      const result = await runPlaceholderUpload(
        "job-1",
        [fakeFile("a.jpg"), fakeFile("b.jpg"), fakeFile("c.jpg")],
        deps,
      );

      expect(result).toEqual({ uploaded: 1, failed: 2, batchClosed: true, closedAt: 1 });
      // No allocation is attempted after the refusal: it would be refused too.
      expect(deps.createUploadUrl).toHaveBeenCalledTimes(2);
      expect(
        progress.filter((p) => p.state === "failed").map((p) => [p.name, p.error]),
      ).toEqual([
        ["b.jpg", "batch closed"],
        ["c.jpg", "batch closed"],
      ]);
    });

    it("reads the refusal from a confirm too, after the bytes landed", async () => {
      const { deps } = harness({
        confirmUpload: vi.fn(async () => {
          throw batchNotCollecting("pairing");
        }),
      });

      const result = await runPlaceholderUpload("job-1", [fakeFile("a.jpg"), fakeFile("b.jpg")], deps);

      expect(result).toEqual({ uploaded: 0, failed: 2, batchClosed: true, closedAt: 0 });
      expect(deps.createUploadUrl).toHaveBeenCalledTimes(1);
    });

    it("treats any other error as one file's failure and keeps going", async () => {
      const { deps } = harness({
        createUploadUrl: vi.fn(async () => {
          // The text alone is not the signal: prod redacts it.
          throw new Error("job is processing, not collecting");
        }),
      });

      const result = await runPlaceholderUpload("job-1", [fakeFile("a.jpg"), fakeFile("b.jpg")], deps);

      expect(result).toEqual({ uploaded: 0, failed: 2 });
      expect(result.batchClosed).toBeUndefined();
      expect(deps.createUploadUrl).toHaveBeenCalledTimes(2);
    });
  });

  it("reports each file as uploading before it reports the outcome", async () => {
    const { deps, progress } = harness();
    await runPlaceholderUpload("job-1", [fakeFile("a.jpg")], deps);

    expect(progress.map((p) => p.state)).toEqual(["uploading", "uploaded"]);
    expect(progress[1].entryIndex).toBe(0);
  });
});
