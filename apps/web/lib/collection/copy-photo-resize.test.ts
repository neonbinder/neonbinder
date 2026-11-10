import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COPY_PHOTO_LONG_EDGE,
  COPY_PHOTO_THUMB_EDGE,
  fitWithin,
  MAX_COPY_PHOTO_BYTES,
  MAX_COPY_THUMB_BYTES,
  resizeCopyPhoto,
} from "./copy-photo-resize";

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

/**
 * NEO-466 — the two encodes, against a stand-in canvas: each `toBlob` waits
 * until the test answers it, so the order and overlap of the encodes show.
 */
describe("resizeCopyPhoto's encodes", () => {
  interface Encode {
    width: number;
    height: number;
    type: string;
    quality: number;
    answer: (blob: Blob | null) => void;
  }

  function stage(bitmapSize = { width: 4000, height: 3000 }, { noContext = false } = {}) {
    const encodes: Encode[] = [];
    const draws: { width: number; height: number }[] = [];
    const bitmap = { ...bitmapSize, close: vi.fn() };
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
    vi.stubGlobal("document", {
      createElement: () => {
        const canvas = {
          width: 0,
          height: 0,
          getContext: () =>
            noContext
              ? null
              : {
                  imageSmoothingQuality: "low",
                  drawImage: (_b: unknown, _x: number, _y: number, width: number, height: number) => draws.push({ width, height }),
                },
          toBlob: (answer: (blob: Blob | null) => void, type: string, quality: number) =>
            encodes.push({ width: canvas.width, height: canvas.height, type, quality, answer }),
        };
        return canvas;
      },
    });
    const file = new File(["x"], "card.jpg", { type: "image/jpeg" });
    return { encodes, draws, bitmap, saving: resizeCopyPhoto(file) };
  }
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  const blob = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });

  it("starts the image and the thumb before either has answered", async () => {
    const { encodes } = stage();
    await settle();
    expect(encodes.map((e) => [e.width, e.height])).toEqual([
      [1600, 1200],
      [360, 270],
    ]);
  });

  it("gives the long-edge encode as the image and the small one as the thumb, whichever answers first", async () => {
    const { encodes, draws, bitmap, saving } = stage({ width: 3000, height: 4200 });
    await settle();
    const image = blob(40);
    const thumb = blob(7);
    encodes[1].answer(thumb);
    encodes[0].answer(image);
    const resized = await saving;
    expect(resized).toEqual({ contentType: "image/jpeg", image, thumb });
    expect(resized.image).toBe(image);
    expect(resized.thumb).toBe(thumb);
    expect(encodes.map(({ width, height, type, quality }) => ({ width, height, type, quality }))).toEqual([
      { width: 1143, height: 1600, type: "image/jpeg", quality: 0.88 },
      { width: 257, height: 360, type: "image/jpeg", quality: 0.8 },
    ]);
    expect(draws).toEqual([
      { width: 1143, height: 1600 },
      { width: 257, height: 360 },
    ]);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["image", MAX_COPY_PHOTO_BYTES + 1, 10],
    ["thumb", 10, MAX_COPY_THUMB_BYTES + 1],
  ])("refuses a photo whose %s comes out over its cap, and closes the bitmap", async (_which, imageBytes, thumbBytes) => {
    const { encodes, bitmap, saving } = stage();
    await settle();
    encodes[0].answer(blob(imageBytes));
    encodes[1].answer(blob(thumbBytes));
    await expect(saving).rejects.toThrow("That photo is too detailed to save. Try another.");
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it("says the browser can't resize when an encode gives nothing back, and closes the bitmap", async () => {
    const { encodes, bitmap, saving } = stage();
    await settle();
    encodes[1].answer(null);
    await expect(saving).rejects.toThrow("This browser can't resize photos.");
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    // The other encode answering late changes nothing.
    encodes[0].answer(blob(10));
    await settle();
  });

  it("says the browser can't resize when there is no 2D canvas", async () => {
    const { bitmap, saving } = stage(undefined, { noContext: true });
    await expect(saving).rejects.toThrow("This browser can't resize photos.");
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
});
