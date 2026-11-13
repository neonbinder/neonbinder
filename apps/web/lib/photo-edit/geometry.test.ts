import { describe, expect, it } from "vitest";
import golden from "./golden.json";
import {
  angleToward,
  asPendingPhotoEdit,
  asPhotoEdit,
  clampCrop,
  cropCorners,
  cropPlacement,
  describeCrop,
  cropExtents,
  cropOrNull,
  dragCorner,
  editsEqual,
  effectiveCrop,
  keptSizes,
  minCropSide,
  normalizeAngle,
  nudgeCrop,
  openingTurns,
  previewGeometry,
  resizeCrop,
  resizeCropSide,
  screenToSourceDelta,
  thumbnailSize,
  tidyEdit,
  tiltCrop,
  turnBy,
  wholeFrame,
  type PhotoCrop,
  type PhotoEdit,
  type QuarterTurns,
} from "./geometry";

/** Every corner of the box lies inside its source (to a hair). */
function inside(crop: PhotoCrop): boolean {
  return cropCorners(crop).every((p) => p.x >= -1e-6 && p.y >= -1e-6 && p.x <= crop.srcW + 1e-6 && p.y <= crop.srcH + 1e-6);
}

describe("golden.json (shared with services/preprocess pytest)", () => {
  for (const c of golden.cases) {
    it(c.name, () => {
      const edit = c.edit as PhotoEdit;
      const [w, h] = c.src;
      const corners = cropCorners(effectiveCrop(edit, w, h));
      corners.forEach((p, i) => {
        expect(p.x).toBeCloseTo(c.expect.corners[i][0], 3);
        expect(p.y).toBeCloseTo(c.expect.corners[i][1], 3);
      });
      const kept = keptSizes(edit, w, h);
      expect([kept.output.w, kept.output.h]).toEqual(c.expect.output);
      expect([kept.image.w, kept.image.h]).toEqual(c.expect.image);
      expect([kept.thumb.w, kept.thumb.h]).toEqual(c.expect.thumb);
    });
  }

  it("opening turns come from the pipeline's counter-clockwise rotation", () => {
    for (const o of golden.openingTurns) {
      expect(openingTurns(o.rotationDegrees ?? undefined), `rotationDegrees ${o.rotationDegrees}`).toBe(o.turns);
    }
  });

  it("never upscales and never exceeds 1600 / 360", () => {
    for (const c of golden.cases) {
      const [ow, oh] = c.expect.output;
      const [iw, ih] = c.expect.image;
      const [tw, th] = c.expect.thumb;
      expect(Math.max(iw, ih)).toBeLessThanOrEqual(1600);
      expect(iw).toBeLessThanOrEqual(ow);
      expect(ih).toBeLessThanOrEqual(oh);
      expect(Math.max(tw, th)).toBeLessThanOrEqual(360);
    }
  });
});

describe("angles and turns", () => {
  it("folds angles into (-180, 180]", () => {
    expect(normalizeAngle(180)).toBe(180);
    expect(normalizeAngle(-180)).toBe(180);
    expect(normalizeAngle(181)).toBe(-179);
    expect(normalizeAngle(-181)).toBe(179);
    expect(normalizeAngle(720)).toBe(0);
    expect(Object.is(normalizeAngle(-360), 0)).toBe(true);
  });

  it("composes quarter turns both ways", () => {
    expect(turnBy(0, -1)).toBe(3);
    expect(turnBy(3, 1)).toBe(0);
    expect(turnBy(1, 6)).toBe(3);
    let t: QuarterTurns = 0;
    for (let i = 0; i < 4; i++) t = turnBy(t, 1);
    expect(t).toBe(0);
  });

  it("Pillow's thumbnail rule keeps the aspect closer (floor on a tie)", () => {
    expect(thumbnailSize(3000, 4200, 1600)).toEqual({ w: 1143, h: 1600 });
    expect(thumbnailSize(1000, 1400, 1600)).toEqual({ w: 1000, h: 1400 });
    expect(thumbnailSize(4000, 4000, 360)).toEqual({ w: 360, h: 360 });
    expect(thumbnailSize(10, 4000, 360)).toEqual({ w: 1, h: 360 });
  });
});

describe("the clamp keeps the box inside its source", () => {
  const src = (over: Partial<PhotoCrop>): PhotoCrop => ({ ...wholeFrame(1000, 1400), ...over });

  it("slides a box that pokes out back in, keeping its size", () => {
    const c = clampCrop(src({ cx: 950, cy: 100, w: 400, h: 400 }));
    expect(c.w).toBe(400);
    expect(c.cx).toBe(800);
    expect(c.cy).toBe(200);
    expect(inside(c)).toBe(true);
  });

  it("shrinks a box too big for the frame about its centre, keeping its shape", () => {
    const c = clampCrop(src({ w: 2000, h: 2800 }));
    expect(c.w / c.h).toBeCloseTo(2000 / 2800, 6);
    expect(inside(c)).toBe(true);
  });

  it("a tilt that would poke the corners out shrinks the box (stored mode: only ever a trim)", () => {
    const whole = wholeFrame(1000, 1400);
    for (const deg of [1, 15, 45, 90, 179, -33]) {
      const c = tiltCrop(whole, deg);
      expect(inside(c), `tilt ${deg}`).toBe(true);
      expect(c.w).toBeLessThanOrEqual(1000);
      expect(c.h).toBeLessThanOrEqual(1400);
    }
  });

  it("never lets the box get smaller than the minimum side", () => {
    let c = wholeFrame(1000, 1400);
    for (let i = 0; i < 400; i++) c = resizeCrop(c, 1 / 1.04);
    expect(Math.min(c.w, c.h)).toBeCloseTo(minCropSide(1000, 1400), 6);
  });

  it("a grow at the full frame stays the full frame", () => {
    const c = resizeCrop(wholeFrame(1000, 1400), 1.5);
    expect(c.w).toBeCloseTo(1000, 6);
    expect(c.h).toBeCloseTo(1400, 6);
  });

  it("extents of a box on its side swap", () => {
    expect(cropExtents({ w: 100, h: 50, angle: 90 }).ex).toBeCloseTo(25, 6);
    expect(cropExtents({ w: 100, h: 50, angle: 90 }).ey).toBeCloseTo(50, 6);
  });
});

describe("keyboard steps follow the screen, whatever the turn", () => {
  const box: PhotoCrop = { cx: 500, cy: 700, w: 200, h: 200, angle: 0, srcW: 1000, srcH: 1400 };

  it("maps a screen move back into the source", () => {
    const right = (t: QuarterTurns) => screenToSourceDelta(1, 0, t);
    expect(right(0).x).toBeCloseTo(1, 9);
    // Turned a quarter right, screen right is source up.
    expect(right(1).y).toBeCloseTo(-1, 9);
    expect(right(2).x).toBeCloseTo(-1, 9);
    expect(right(3).y).toBeCloseTo(1, 9);
  });

  it("Arrow steps 0.5% of the long edge, Shift 5%", () => {
    expect(nudgeCrop(box, 1, 0, 0).cx).toBeCloseTo(507, 6);
    expect(nudgeCrop(box, 0, 1, 0, true).cy).toBeCloseTo(770, 6);
    expect(nudgeCrop(box, 1, 0, 1).cy).toBeCloseTo(693, 6);
  });

  it("tilts by a degree and wraps at the half turn", () => {
    expect(tiltCrop(box, 1).angle).toBe(1);
    expect(tiltCrop({ ...box, angle: 180 }, 1).angle).toBe(-179);
    expect(tiltCrop({ ...box, angle: -179 }, -15).angle).toBe(166);
  });
});

describe("pointer tools", () => {
  const box: PhotoCrop = { cx: 500, cy: 700, w: 400, h: 600, angle: 0, srcW: 1000, srcH: 1400 };

  it("a corner drag keeps the opposite corner put", () => {
    const moved = dragCorner(box, 2, { x: 800, y: 1100 });
    const tl = cropCorners(moved)[0];
    expect(tl.x).toBeCloseTo(300, 6);
    expect(tl.y).toBeCloseTo(400, 6);
    expect(moved.w).toBeCloseTo(500, 6);
    expect(moved.h).toBeCloseTo(700, 6);
  });

  it("a corner dragged past its anchor stops at the minimum, never inside out", () => {
    const moved = dragCorner(box, 2, { x: 0, y: 0 });
    expect(moved.w).toBeCloseTo(minCropSide(1000, 1400), 6);
    const tl = cropCorners(moved)[0];
    expect(tl.x).toBeCloseTo(300, 6);
  });

  it("a corner drag on a tilted box keeps its angle", () => {
    const tilted = { ...box, angle: 20 };
    const anchor = cropCorners(tilted)[0];
    const moved = dragCorner(tilted, 2, { x: 700, y: 900 });
    expect(moved.angle).toBe(20);
    expect(cropCorners(moved)[0].x).toBeCloseTo(anchor.x, 6);
  });

  it("the spin handle points the box's top at the pointer", () => {
    expect(angleToward(box, { x: 500, y: 100 })).toBe(0);
    expect(angleToward(box, { x: 900, y: 700 })).toBe(90);
    expect(angleToward(box, { x: 500, y: 1300 })).toBe(180);
    expect(angleToward(box, { x: 100, y: 700 })).toBe(-90);
  });
});

describe("previews and the wire", () => {
  it("a preview's view box is the output's shape", () => {
    const g = previewGeometry({ turns: 1, crop: { cx: 500, cy: 700, w: 400, h: 600, angle: 10, srcW: 1000, srcH: 1400 } }, 1000, 1400);
    expect(g.viewW).toBe(600);
    expect(g.viewH).toBe(400);
    expect(g.transform).toBe("translate(300 200) rotate(80) translate(-500 -700)");
  });

  it("an upright box over the whole frame is no crop", () => {
    expect(cropOrNull(wholeFrame(1000, 1400))).toBeNull();
    expect(cropOrNull({ ...wholeFrame(1000, 1400), angle: 1 })).not.toBeNull();
  });

  it("equal edits compare equal across a scaled frame", () => {
    const a: PhotoEdit = { turns: 0, crop: { cx: 500, cy: 700, w: 400, h: 600, angle: 10, srcW: 1000, srcH: 1400 } };
    const b: PhotoEdit = { turns: 0, crop: { cx: 250, cy: 350, w: 200, h: 300, angle: 10, srcW: 500, srcH: 700 } };
    expect(editsEqual(a, b)).toBe(true);
    expect(editsEqual(a, { ...a, turns: 1 })).toBe(false);
    expect(editsEqual(a, { turns: 0, crop: null })).toBe(false);
  });

  it("resizes one side alone, and growing stops at the frame instead of squeezing the other side", () => {
    const box: PhotoCrop = { cx: 500, cy: 700, w: 400, h: 600, angle: 0, srcW: 1000, srcH: 1400 };
    const wider = resizeCropSide(box, "w", 1.5);
    expect([wider.w, wider.h]).toEqual([600, 600]);
    const shorter = resizeCropSide(box, "h", 0.5);
    expect([shorter.w, shorter.h]).toEqual([400, 300]);
    // As wide as the frame allows, then no further, and the height never gives way.
    let w = box;
    for (let i = 0; i < 40; i++) w = resizeCropSide(w, "w", 1.04);
    expect(w.w).toBeCloseTo(1000, 6);
    expect(w.h).toBe(600);
    // Tilted, the cap is where a turned corner meets the edge.
    let t: PhotoCrop = { ...box, angle: 20 };
    for (let i = 0; i < 60; i++) t = resizeCropSide(t, "h", 1.04);
    expect(t.w).toBe(400);
    expect(inside(t)).toBe(true);
    const { ey } = cropExtents(t);
    expect(2 * ey).toBeCloseTo(1400, 4);
  });

  it("says where the box sits on screen, the turn included", () => {
    const edit: PhotoEdit = { turns: 0, crop: { cx: 300, cy: 400, w: 200, h: 400, angle: 0, srcW: 1000, srcH: 1400 } };
    // Left gap 200 of 1000, top gap 200 of 1400.
    expect(cropPlacement(edit, 1000, 1400)).toEqual({ left: 20, top: 14 });
    // A quarter turn right: the source's left edge is now the top, its bottom the left.
    // Shown 1400 wide by 1000 tall: left gap = source bottom gap 800 of 1400, top gap = source left gap 200 of 1000.
    expect(cropPlacement({ ...edit, turns: 1 }, 1000, 1400)).toEqual({ left: 57, top: 20 });
    expect(describeCrop(edit, 1000, 1400)).toBe("Tilted 0°, 200 by 400 pixels, 20% from the left and 14% from the top.");
    expect(cropPlacement({ turns: 2, crop: null }, 1000, 1400)).toEqual({ left: 0, top: 0 });
  });

  it("tidies numbers for the wire", () => {
    const t = tidyEdit({ turns: 2, crop: { cx: 5.234567, cy: 5, w: 3, h: 4, angle: -180, srcW: 10, srcH: 10 } });
    expect(t.crop?.cx).toBe(5.23);
    expect(t.crop?.angle).toBe(180);
    expect(tidyEdit({ turns: 1, crop: null })).toEqual({ turns: 1, crop: null });
  });

  /** Every corner inside the frame, with no slack at all (the server allows 1e-6 of the long side). */
  const strictlyInside = (crop: PhotoCrop) =>
    cropCorners(crop).every((p) => p.x >= -1e-9 && p.y >= -1e-9 && p.x <= crop.srcW + 1e-9 && p.y <= crop.srcH + 1e-9);

  it("never lets rounding push a corner past an edge", () => {
    // A box that fills the frame to the last float, tilted: rounding to the hundredth would overshoot.
    const tight = clampCrop({ cx: 0, cy: 0, w: 99999, h: 99999 * 1.4, angle: 13.337, srcW: 3001.237, srcH: 4199.991 });
    expect(strictlyInside(tight)).toBe(true);
    const sent = tidyEdit({ turns: 0, crop: tight }).crop!;
    expect(strictlyInside(sent)).toBe(true);
    expect(sent.w).toBeGreaterThan(tight.w - 1); // the rounded tilt costs a fraction of a pixel

    // Upright and flush against two edges.
    const flush = tidyEdit({ turns: 3, crop: { cx: 100.004999, cy: 699.995001, w: 200.009998, h: 200.00999, angle: 0, srcW: 1000, srcH: 800 } }).crop!;
    expect(strictlyInside(flush)).toBe(true);

    // Too big for the frame (a stale box): shrinks to fit.
    expect(strictlyInside(tidyEdit({ turns: 0, crop: { cx: 500, cy: 400, w: 1200, h: 900, angle: 20, srcW: 1000, srcH: 800 } }).crop!)).toBe(true);

    // Any clamped box survives the trip.
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 300; i++) {
      const srcW = 200 + rand() * 4000;
      const srcH = 200 + rand() * 4000;
      const box = clampCrop({ cx: rand() * srcW, cy: rand() * srcH, w: rand() * srcW * 1.5, h: rand() * srcH * 1.5, angle: rand() * 360 - 180, srcW, srcH });
      expect(strictlyInside(tidyEdit({ turns: 0, crop: box }).crop!)).toBe(true);
    }
  });

  it("reads a pending edit in the stored row's flat shape, and refuses junk", () => {
    expect(asPendingPhotoEdit({ status: "failed", turns: 1, crop: null, error: "No luck" })).toEqual({
      status: "failed",
      edit: { turns: 1, crop: null },
      error: "No luck",
    });
    expect(asPendingPhotoEdit({ status: "rendering", turns: 5, crop: null })).toBeUndefined();
    expect(asPendingPhotoEdit({ status: "queued", turns: 0, crop: null })).toBeUndefined();
    expect(asPhotoEdit({ turns: 0, crop: { cx: Number.NaN } })).toBeNull();
  });
});
