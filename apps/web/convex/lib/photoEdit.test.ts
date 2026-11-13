/**
 * NEO-481 — the pure half of a hand photo edit: the crop checks a validator
 * cannot express, the opening turns, the wire shapes, and the write-once keys
 * an edit's render lands under.
 */

import { describe, expect, test } from "vitest";
import {
  cropExtents,
  openingTurns,
  parseCropBox,
  photoEditOf,
  photoEditProblem,
  photoEditToWire,
  samePhotoEdit,
  type PhotoEditCrop,
} from "./photoEdit";
import { placeholderEditCopyPhotoObject, placeholderEditOutputObject } from "./placeholderObjects";

const BOX: PhotoEditCrop = { cx: 500, cy: 700, w: 600, h: 900, angle: 0, srcW: 1000, srcH: 1400 };

describe("photoEditProblem", () => {
  test("the whole source, any quarter turn, is fine", () => {
    for (const turns of [0, 1, 2, 3] as const) expect(photoEditProblem({ turns, crop: null })).toBeNull();
  });

  test("a turn that is not a quarter turn is refused", () => {
    expect(photoEditProblem({ turns: 4 as 0, crop: null })).toMatch(/turn/);
  });

  test("a box inside the frame, turned either way, is fine; the full frame is fine", () => {
    expect(photoEditProblem({ turns: 0, crop: { ...BOX, angle: 10 } })).toBeNull();
    expect(photoEditProblem({ turns: 0, crop: { ...BOX, angle: -10 } })).toBeNull();
    expect(photoEditProblem({ turns: 0, crop: { ...BOX, w: 1000, h: 1400 } })).toBeNull();
    expect(photoEditProblem({ turns: 0, crop: { ...BOX, angle: 180 } })).toBeNull();
  });

  test("a box past the edge is refused, to float slack only", () => {
    expect(photoEditProblem({ turns: 0, crop: { ...BOX, cx: 750 } })).toMatch(/past the edge/);
    // Float slack (1e-6 of the frame) passes; a tenth of a pixel over does not,
    // since the service allows only half a source pixel after scaling.
    expect(photoEditProblem({ turns: 0, crop: { ...BOX, w: 1000, h: 1400 + 1e-4 } })).toBeNull();
    expect(photoEditProblem({ turns: 0, crop: { ...BOX, w: 1000, h: 1400.2 } })).toMatch(/past the edge/);
    // A fitted box turned by float noise sits on the edges and passes.
    expect(photoEditProblem({ turns: 0, crop: { ...BOX, w: 1000, h: 1400, angle: 1e-9 } })).toBeNull();
    // A turned full-frame box reaches its corners outside.
    expect(photoEditProblem({ turns: 0, crop: { ...BOX, w: 1000, h: 1400, angle: 5 } })).toMatch(/past the edge/);
  });

  test("non-finite numbers, a frame that is not whole pixels, an empty box, or a wild angle are refused", () => {
    expect(photoEditProblem({ turns: 0, crop: { ...BOX, cx: Number.NaN } })).toMatch(/isn't a box/);
    expect(photoEditProblem({ turns: 0, crop: { ...BOX, srcW: 1000.5 } })).toMatch(/isn't a box/);
    expect(photoEditProblem({ turns: 0, crop: { ...BOX, srcH: 0 } })).toMatch(/isn't a box/);
    expect(photoEditProblem({ turns: 0, crop: { ...BOX, srcW: 60_000 } })).toMatch(/isn't a box/);
    expect(photoEditProblem({ turns: 0, crop: { ...BOX, w: 0 } })).toMatch(/too small/);
    expect(photoEditProblem({ turns: 0, crop: { ...BOX, angle: -180 } })).toMatch(/turned past/);
    expect(photoEditProblem({ turns: 0, crop: { ...BOX, angle: 181 } })).toMatch(/turned past/);
  });
});

test("cropExtents: a box turned 90 degrees swaps its reach", () => {
  const { ex, ey } = cropExtents({ w: 600, h: 900, angle: 90 });
  expect(ex).toBeCloseTo(450);
  expect(ey).toBeCloseTo(300);
});

test("openingTurns: counter-clockwise degrees become clockwise quarter turns", () => {
  expect([0, 90, 180, 270, -90, undefined, Number.NaN, 85].map(openingTurns)).toEqual([0, 3, 2, 1, 1, 0, 0, 3]);
});

test("photoEditToWire: snake_case frame, null crop kept", () => {
  expect(photoEditToWire({ turns: 2, crop: null })).toEqual({ turns: 2, crop: null });
  expect(photoEditToWire({ turns: 1, crop: BOX })).toEqual({
    turns: 1,
    crop: { cx: 500, cy: 700, w: 600, h: 900, angle: 0, src_w: 1000, src_h: 1400 },
  });
});

describe("parseCropBox", () => {
  test("takes either case of the frame and copies only the box's fields", () => {
    const wire = { cx: 500, cy: 700, w: 600, h: 900, angle: 0, src_w: 1000, src_h: 1400, extra: "x" };
    expect(parseCropBox(wire)).toEqual(BOX);
    expect(parseCropBox({ ...BOX })).toEqual(BOX);
  });

  test("anything not a whole box inside its frame is dropped, never thrown", () => {
    for (const value of [undefined, null, 3, "box", [BOX], { ...BOX, w: "600" }, { ...BOX, cx: 900 }, { cx: 1 }]) {
      expect(parseCropBox(value)).toBeUndefined();
    }
  });
});

test("samePhotoEdit and photoEditOf", () => {
  expect(samePhotoEdit({ turns: 1, crop: BOX }, { turns: 1, crop: { ...BOX } })).toBe(true);
  expect(samePhotoEdit({ turns: 1, crop: BOX }, { turns: 2, crop: BOX })).toBe(false);
  expect(samePhotoEdit({ turns: 1, crop: null }, { turns: 1, crop: BOX })).toBe(false);
  expect(samePhotoEdit({ turns: 1, crop: BOX }, { turns: 1, crop: { ...BOX, cx: 501 } })).toBe(false);
  const stored = { turns: 1 as const, crop: BOX, version: 3, editedAt: 9 };
  expect(photoEditOf(stored)).toEqual({ turns: 1, crop: BOX });
});

describe("edit object keys", () => {
  const user = "user_abc123";
  const job = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

  test("each version is its own write-once key", () => {
    expect(placeholderEditOutputObject(user, job, 7, 2)).toBe(`placeholders/${user}/${job}/output/edits/0007/2.jpg`);
    expect(placeholderEditCopyPhotoObject(user, job, 7, 2, "thumb")).toBe(
      `placeholders/${user}/${job}/output/edits/0007/2/thumb.jpg`,
    );
  });

  test("a version that is not a positive whole number throws", () => {
    for (const version of [0, -1, 1.5, Number.NaN]) {
      expect(() => placeholderEditOutputObject(user, job, 7, version)).toThrow();
      expect(() => placeholderEditCopyPhotoObject(user, job, 7, version, "image")).toThrow();
    }
  });
});
