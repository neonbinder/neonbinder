import { describe, expect, test } from "vitest";
import { deriveStage, waitingHeadline } from "./intake-stage";

describe("waitingHeadline", () => {
  test.each([
    [6, 0, "All 6 photos read."],
    [1, 0, "All 1 photo read."],
    [6, 2, "4 of 6 photos read. 2 couldn't be."],
    [2, 1, "1 of 2 photos read. 1 couldn't be."],
    [6, 6, "Couldn't read any of your 6 photos."],
    [1, 1, "Couldn't read your photo."],
  ])("%i photos, %i failed: %s", (total, failed, headline) => {
    expect(waitingHeadline(total, failed)).toBe(headline);
  });
});

const base = { job: null, images: undefined, uploading: false, selectedCount: 0 };
const img = (status: string) => ({ status });
const job = (status: string, over: Partial<{ totalImages: number; processedImages: number; failedImages: number }> = {}) => ({
  status,
  totalImages: 0,
  processedImages: 0,
  failedImages: 0,
  ...over,
});

describe("deriveStage", () => {
  test("nothing chosen yet", () => {
    expect(deriveStage(base)).toBe("empty");
  });

  test("files chosen but not sent", () => {
    expect(deriveStage({ ...base, selectedCount: 3 })).toBe("ready");
  });

  test("uploading beats everything — bytes are moving", () => {
    expect(deriveStage({ ...base, uploading: true, job: job("collecting") })).toBe(
      "uploading",
    );
  });

  // The state the old page had no name for, and the reason this helper exists:
  // the batch is open, nothing is in flight, so it is waiting on the PERSON.
  test("open with every image settled is waiting on the user", () => {
    expect(
      deriveStage({
        ...base,
        job: job("collecting"),
        images: [img("done"), img("done"), img("failed")],
      }),
    ).toBe("waiting");
  });

  test("open with anything still in flight is working", () => {
    expect(
      deriveStage({
        ...base,
        job: job("collecting"),
        images: [img("done"), img("processing")],
      }),
    ).toBe("working");
  });

  test("an open batch with no images yet is working, not waiting", () => {
    // Nothing settled AND nothing in flight — prompting "add more or finish"
    // at an empty batch would be asking the user to finish nothing.
    expect(deriveStage({ ...base, job: job("collecting"), images: [] })).toBe(
      "working",
    );
  });

  test.each(["extracting", "processing", "pairing"])(
    "%s is finishing — the user already said that's everything",
    (status) => {
      expect(
        deriveStage({ ...base, job: job(status), images: [img("done")] }),
      ).toBe("finishing");
    },
  );

  test("succeeded is done", () => {
    expect(deriveStage({ ...base, job: job("succeeded") })).toBe("done");
  });

  test("failed is failed", () => {
    expect(deriveStage({ ...base, job: job("failed") })).toBe("failed");
  });

  test("a discarded batch is also 'failed' — there is no canceled status", () => {
    // cancelJobImpl writes status "failed" with errorCode CANCELED. The stage
    // model deliberately does not distinguish them; the failure COPY does,
    // off the error code, so a discard does not read as a malfunction.
    expect(deriveStage({ ...base, job: job("failed") })).toBe("failed");
  });
});
