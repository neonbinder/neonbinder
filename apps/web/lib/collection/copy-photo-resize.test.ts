import { afterEach, describe, expect, it, vi } from "vitest";
import { COPY_PHOTO_LONG_EDGE, COPY_PHOTO_THUMB_EDGE, fitWithin, resizeCopyPhoto } from "./copy-photo-resize";

/**
 * NEO-377 — the size a copy photo is drawn at, and the refusal of a file the
 * browser can't open. The canvas encode itself needs a real browser (jsdom
 * has none); the photos E2E spec covers it end to end.
 */
afterEach(() => vi.unstubAllGlobals());

describe("fitWithin", () => {
  it("caps the long edge, keeps the shape, and never scales up", () => {
    expect(fitWithin(4000, 3000, COPY_PHOTO_LONG_EDGE)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4200, COPY_PHOTO_THUMB_EDGE)).toEqual({ width: 257, height: 360 });
    expect(fitWithin(800, 600, COPY_PHOTO_LONG_EDGE)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(10_000, 1, COPY_PHOTO_THUMB_EDGE)).toEqual({ width: 360, height: 1 });
  });
});

describe("resizeCopyPhoto", () => {
  it("refuses a file this browser can't open as a picture", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("bad")));
    await expect(resizeCopyPhoto(new File(["%PDF"], "list.pdf", { type: "application/pdf" }))).rejects.toThrow(
      "That file isn't a photo this browser can open. Try a JPG or PNG.",
    );
  });
});
