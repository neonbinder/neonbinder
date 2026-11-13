/**
 * NEO-481 — the geometry of a hand edit: a quarter turn and a crop box that
 * can spin a full circle about its centre. Pure numbers, no DOM.
 *
 * One contract, three readers: the viewer (this file), the preprocess
 * renderer (`services/preprocess/app/edit.py`) and the Convex checks.
 * `golden.json` beside this file pins the shared answers (corner points and
 * output sizes for given parameters); vitest and pytest both read it, so the
 * browser and the server cannot drift.
 *
 * Conventions (all of them in `golden.json` too):
 * - Source pixels, origin top-left, y down. For a scan the source is the
 *   EXIF-uprighted original; for a stored photo it is that photo.
 * - `angle` is degrees CLOCKWISE on screen, in (-180, 180]. The box's own top
 *   edge becomes the output's top edge.
 * - `turns` are quarter turns clockwise, applied LAST (after the crop).
 * - A crop carries the frame it was drawn in (`srcW` x `srcH`); a source of
 *   another size scales it uniformly.
 * - Pixel sizes round half up: `floor(v + 0.5)`, never banker's rounding.
 * - The kept sizes follow Pillow's `Image.thumbnail` (as `derive_copy_photos`
 *   does): long edge 1600, then 360 from that, never upscaled.
 */

import { COPY_PHOTO_LONG_EDGE, COPY_PHOTO_THUMB_EDGE } from "@/lib/collection/copy-photo-resize";

export type QuarterTurns = 0 | 1 | 2 | 3;

/** A hand crop, in source pixels of the frame `srcW` x `srcH`. */
export interface PhotoCrop {
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Degrees clockwise, (-180, 180]. */
  angle: number;
  srcW: number;
  srcH: number;
}

/** `PhotoEdit` (the schema's `photoEditValidator`): quarter turns clockwise, applied last; no crop = the whole source. */
export interface PhotoEdit {
  turns: QuarterTurns;
  crop: PhotoCrop | null;
}

/** An edit the server accepted and is still rendering, or one whose render failed. The photo shown is the old one. */
export interface PendingPhotoEdit {
  status: "rendering" | "failed";
  edit: PhotoEdit;
  /** Why the render failed, in words for the collector. */
  error?: string;
}

export interface Point {
  x: number;
  y: number;
}

/** No edit: the source as it is. */
export const NO_EDIT: PhotoEdit = { turns: 0, crop: null };

/** Round half up, the one rounding rule (`golden.json` → conventions). */
export function roundHalfUp(v: number): number {
  return Math.floor(v + 0.5);
}

/** An angle folded into (-180, 180]. */
export function normalizeAngle(angle: number): number {
  let r = ((angle % 360) + 360) % 360;
  if (r > 180) r -= 360;
  // Never -0: it would print as "-0°".
  return r === 0 ? 0 : r;
}

/** Quarter turns after turning `delta` more (negative = counter-clockwise). */
export function turnBy(turns: QuarterTurns, delta: number): QuarterTurns {
  return ((((turns + delta) % 4) + 4) % 4) as QuarterTurns;
}

/**
 * The opening turns of a scan with no hand edit, from the pipeline's
 * `rotationDegrees` (COUNTER-clockwise). The first save then reproduces
 * today's output (row S, contract rule Q5).
 */
export function openingTurns(rotationDegrees: number | undefined): QuarterTurns {
  const ccw = rotationDegrees ?? 0;
  const cw = (((360 - ccw) % 360) + 360) % 360;
  return (roundHalfUp(cw / 90) % 4) as QuarterTurns;
}

/** The crop that keeps the whole source. */
export function wholeFrame(srcW: number, srcH: number): PhotoCrop {
  return { cx: srcW / 2, cy: srcH / 2, w: srcW, h: srcH, angle: 0, srcW, srcH };
}

/** A crop moved into a source of another size, scaled uniformly by the width. */
export function scaleCrop(crop: PhotoCrop, srcW: number, srcH: number): PhotoCrop {
  if (crop.srcW === srcW && crop.srcH === srcH) return crop;
  const s = srcW / crop.srcW;
  return { cx: crop.cx * s, cy: crop.cy * s, w: crop.w * s, h: crop.h * s, angle: crop.angle, srcW, srcH };
}

/** `p` turned `deg` degrees clockwise (y down) about the origin. */
export function rotatePoint(p: Point, deg: number): Point {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/** The box's corners in source pixels: its own top-left, top-right, bottom-right, bottom-left. */
export function cropCorners(crop: PhotoCrop): [Point, Point, Point, Point] {
  const hw = crop.w / 2;
  const hh = crop.h / 2;
  const at = (x: number, y: number) => {
    const r = rotatePoint({ x, y }, crop.angle);
    return { x: crop.cx + r.x, y: crop.cy + r.y };
  };
  return [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)];
}

/** Half the width and height of the upright rectangle that holds the turned box. */
export function cropExtents(crop: Pick<PhotoCrop, "w" | "h" | "angle">): { ex: number; ey: number } {
  const t = (crop.angle * Math.PI) / 180;
  const c = Math.abs(Math.cos(t));
  const s = Math.abs(Math.sin(t));
  return { ex: (crop.w * c + crop.h * s) / 2, ey: (crop.w * s + crop.h * c) / 2 };
}

/** The smallest box side the tools allow: 2% of the short edge, at least 8 px. */
export function minCropSide(srcW: number, srcH: number): number {
  return Math.max(8, 0.02 * Math.min(srcW, srcH));
}

const clampTo = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));

/**
 * The box kept inside its source: never smaller than `minCropSide`, shrunk
 * about its centre (keeping its shape) until its turned outline fits, then
 * slid back in. Inside the frame is also what makes a stored photo's crop
 * "can only trim": the frame IS the current photo.
 */
export function clampCrop(crop: PhotoCrop): PhotoCrop {
  const { srcW, srcH } = crop;
  const angle = normalizeAngle(crop.angle);
  const min = minCropSide(srcW, srcH);
  let w = Math.max(min, crop.w);
  let h = Math.max(min, crop.h);
  const first = cropExtents({ w, h, angle });
  const fit = Math.min(1, srcW / (2 * first.ex), srcH / (2 * first.ey));
  w *= fit;
  h *= fit;
  const { ex, ey } = cropExtents({ w, h, angle });
  return { cx: clampTo(crop.cx, ex, srcW - ex), cy: clampTo(crop.cy, ey, srcH - ey), w, h, angle, srcW, srcH };
}

/** The crop an edit cuts, in a source of this size: its own (scaled), else the whole frame. */
export function effectiveCrop(edit: PhotoEdit, srcW: number, srcH: number): PhotoCrop {
  return edit.crop ? scaleCrop(edit.crop, srcW, srcH) : wholeFrame(srcW, srcH);
}

/** The rendered pixel size of an edit (before the 1600/360 fit): the crop's size, swapped by an odd turn. */
export function outputSize(edit: PhotoEdit, srcW: number, srcH: number): { w: number; h: number } {
  const crop = effectiveCrop(edit, srcW, srcH);
  const w = Math.max(1, roundHalfUp(crop.w));
  const h = Math.max(1, roundHalfUp(crop.h));
  return edit.turns % 2 === 1 ? { w: h, h: w } : { w, h };
}

/** Pillow's `Image.thumbnail` size rule: fit `edge` x `edge`, keep the aspect, never upscale. */
export function thumbnailSize(w: number, h: number, edge: number): { w: number; h: number } {
  if (edge >= w && edge >= h) return { w, h };
  const aspect = w / h;
  // Pillow's round_aspect: floor or ceil, whichever keeps the aspect closer (a tie takes floor), at least 1.
  const roundAspect = (n: number, key: (k: number) => number) => {
    const lo = Math.floor(n);
    const hi = Math.ceil(n);
    return Math.max(key(hi) < key(lo) ? hi : lo, 1);
  };
  if (edge / edge >= aspect) {
    return { w: roundAspect(edge * aspect, (k) => Math.abs(aspect - k / edge)), h: edge };
  }
  return { w: edge, h: roundAspect(edge / aspect, (k) => (k === 0 ? 0 : Math.abs(aspect - edge / k))) };
}

/** The two kept sizes of an edit: the listing image (long edge 1600) and its thumbnail (360, made from the image). */
export function keptSizes(edit: PhotoEdit, srcW: number, srcH: number) {
  const out = outputSize(edit, srcW, srcH);
  const image = thumbnailSize(out.w, out.h, COPY_PHOTO_LONG_EDGE);
  const thumb = thumbnailSize(image.w, image.h, COPY_PHOTO_THUMB_EDGE);
  return { output: out, image, thumb };
}

// ───────────────────────────────────────────────────────────────────────────
// Drawing: the source turned for display, and an edit previewed as a picture
// ───────────────────────────────────────────────────────────────────────────

/** The source's size on screen once turned. */
export function turnedSize(turns: QuarterTurns, srcW: number, srcH: number): { w: number; h: number } {
  return turns % 2 === 1 ? { w: srcH, h: srcW } : { w: srcW, h: srcH };
}

/** An SVG transform from source pixels to the turned display (the crop stage). */
export function turnTransform(turns: QuarterTurns, srcW: number, srcH: number): string {
  switch (turns) {
    case 1:
      return `translate(${srcH} 0) rotate(90)`;
    case 2:
      return `translate(${srcW} ${srcH}) rotate(180)`;
    case 3:
      return `translate(0 ${srcW}) rotate(270)`;
    default:
      return "";
  }
}

/**
 * How to draw an edit's result from its source with no render: an SVG
 * `viewBox` the size of the output and a transform for an `<image>` drawn
 * at `srcW` x `srcH`. The live preview (never saved) and the demo use it.
 */
export function previewGeometry(edit: PhotoEdit, srcW: number, srcH: number) {
  const crop = effectiveCrop(edit, srcW, srcH);
  const odd = edit.turns % 2 === 1;
  const viewW = odd ? crop.h : crop.w;
  const viewH = odd ? crop.w : crop.h;
  const spin = normalizeAngle(edit.turns * 90 - crop.angle);
  return {
    viewW,
    viewH,
    transform: `translate(${viewW / 2} ${viewH / 2}) rotate(${spin}) translate(${-crop.cx} ${-crop.cy})`,
  };
}

/** A move on screen (the turned display) as a move in source pixels. */
export function screenToSourceDelta(dx: number, dy: number, turns: QuarterTurns): Point {
  return rotatePoint({ x: dx, y: dy }, -90 * turns);
}

// ───────────────────────────────────────────────────────────────────────────
// The tools: each returns a new, clamped crop
// ───────────────────────────────────────────────────────────────────────────

/** One nudge, in source pixels: 0.5% of the long edge (5% with Shift), at least 1 px. */
export function nudgeStep(crop: PhotoCrop, big: boolean): number {
  return Math.max(1, (big ? 0.05 : 0.005) * Math.max(crop.srcW, crop.srcH));
}

/** Move the box by a step in a screen direction (`dx`, `dy` in -1..1). */
export function nudgeCrop(crop: PhotoCrop, dx: number, dy: number, turns: QuarterTurns, big = false): PhotoCrop {
  const step = nudgeStep(crop, big);
  const d = screenToSourceDelta(dx * step, dy * step, turns);
  return clampCrop({ ...crop, cx: crop.cx + d.x, cy: crop.cy + d.y });
}

/** Grow (factor > 1) or shrink the box about its centre. */
export function resizeCrop(crop: PhotoCrop, factor: number): PhotoCrop {
  return clampCrop({ ...crop, w: crop.w * factor, h: crop.h * factor });
}

/** One resize step: 4% of the box. */
export const RESIZE_STEP = 1.04;

/**
 * Grow (factor > 1) or shrink only the box's width or only its height, about
 * its centre. Growing stops where the turned box would leave the frame, so
 * the other side never shrinks to make room.
 */
export function resizeCropSide(crop: PhotoCrop, side: "w" | "h", factor: number): PhotoCrop {
  const t = (normalizeAngle(crop.angle) * Math.PI) / 180;
  const c = Math.abs(Math.cos(t));
  const s = Math.abs(Math.sin(t));
  const other = side === "w" ? crop.h : crop.w;
  // The turned box's upright extents are (w·c + h·s, w·s + h·c): for `side` = w,
  // w·c + h·s ≤ srcW and w·s + h·c ≤ srcH; for `side` = h the frame's axes swap roles.
  const [alongW, alongH] = side === "w" ? [c, s] : [s, c];
  const cap = (room: number, k: number) => (k > 1e-9 ? room / k : Number.POSITIVE_INFINITY);
  const most = Math.min(
    cap(crop.srcW - other * (side === "w" ? s : c), alongW),
    cap(crop.srcH - other * (side === "w" ? c : s), alongH),
  );
  const current = side === "w" ? crop.w : crop.h;
  const next = factor > 1 ? Math.max(current, Math.min(current * factor, most)) : current * factor;
  return clampCrop(side === "w" ? { ...crop, w: next } : { ...crop, h: next });
}

/** Tilt the box `deg` more degrees clockwise. */
export function tiltCrop(crop: PhotoCrop, deg: number): PhotoCrop {
  return clampCrop({ ...crop, angle: normalizeAngle(crop.angle + deg) });
}

/** Set the box's angle outright. */
export function setCropAngle(crop: PhotoCrop, angle: number): PhotoCrop {
  return clampCrop({ ...crop, angle: normalizeAngle(angle) });
}

/** Move the box so its centre sits at `to` (source pixels). */
export function moveCropTo(crop: PhotoCrop, to: Point): PhotoCrop {
  return clampCrop({ ...crop, cx: to.x, cy: to.y });
}

/** Which way each corner lies from the centre, in the box's own frame (TL, TR, BR, BL). */
const CORNER_SIGNS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/**
 * Drag one corner (0 TL, 1 TR, 2 BR, 3 BL) to `to`, the opposite corner
 * staying put. The box keeps its angle and never turns inside out.
 */
export function dragCorner(crop: PhotoCrop, corner: number, to: Point): PhotoCrop {
  const [sx, sy] = CORNER_SIGNS[corner];
  const anchor = cropCorners(crop)[(corner + 2) % 4];
  const local = rotatePoint({ x: to.x - anchor.x, y: to.y - anchor.y }, -crop.angle);
  const min = minCropSide(crop.srcW, crop.srcH);
  const w = Math.max(min, sx * local.x);
  const h = Math.max(min, sy * local.y);
  const half = rotatePoint({ x: (sx * w) / 2, y: (sy * h) / 2 }, crop.angle);
  return clampCrop({ ...crop, w, h, cx: anchor.x + half.x, cy: anchor.y + half.y });
}

/** The angle that points the box's spin handle (above its top edge) at `to`. */
export function angleToward(crop: PhotoCrop, to: Point): number {
  const deg = (Math.atan2(to.y - crop.cy, to.x - crop.cx) * 180) / Math.PI;
  return normalizeAngle(Math.round(deg + 90));
}

/** Two edits that render the same picture (to a hundredth of a pixel or degree). */
export function editsEqual(a: PhotoEdit, b: PhotoEdit): boolean {
  if (a.turns !== b.turns) return false;
  if (!a.crop || !b.crop) return a.crop === b.crop;
  const near = (x: number, y: number) => Math.abs(x - y) < 0.01;
  const ca = a.crop;
  const cb = scaleCrop(b.crop, ca.srcW, ca.srcH);
  return near(ca.cx, cb.cx) && near(ca.cy, cb.cy) && near(ca.w, cb.w) && near(ca.h, cb.h) && near(normalizeAngle(ca.angle), normalizeAngle(cb.angle));
}

/** The crop if it changes anything, else null: a box over the whole, upright frame is no crop. */
export function cropOrNull(crop: PhotoCrop): PhotoCrop | null {
  const whole = wholeFrame(crop.srcW, crop.srcH);
  return editsEqual({ turns: 0, crop }, { turns: 0, crop: whole }) ? null : crop;
}

/**
 * A crop's numbers rounded for the wire (a hundredth of a pixel or degree),
 * and kept inside the frame after rounding. The server takes a box only when
 * every corner sits inside the frame within float slack, so the size rounds
 * down and the centre snaps inward: rounding can never push a corner past an
 * edge. A box too big for the frame shrinks about its centre first.
 */
export function tidyEdit(edit: PhotoEdit): PhotoEdit {
  if (!edit.crop) return { turns: edit.turns, crop: null };
  const c = edit.crop;
  const { srcW, srcH } = c;
  const near = (v: number) => Math.round(v * 100) / 100;
  const down = (v: number) => Math.floor(v * 100) / 100;
  const up = (v: number) => Math.ceil(v * 100) / 100;
  /** `v` to a hundredth, inside [lo, hi] on the hundredths grid; null when no hundredth fits. */
  const place = (v: number, lo: number, hi: number) => {
    const a = up(lo);
    const b = down(hi);
    return a > b ? null : Math.min(b, Math.max(a, near(v)));
  };
  const angle = normalizeAngle(near(c.angle));
  let w = down(c.w);
  let h = down(c.h);
  for (let tries = 0; tries < 50; tries++) {
    const { ex, ey } = cropExtents({ w, h, angle });
    const fit = Math.min(1, srcW / (2 * ex), srcH / (2 * ey));
    if (fit < 1) {
      w = down(w * fit);
      h = down(h * fit);
      continue;
    }
    const cx = place(c.cx, ex, srcW - ex);
    const cy = place(c.cy, ey, srcH - ey);
    if (cx !== null && cy !== null) return { turns: edit.turns, crop: { cx, cy, w, h, angle, srcW, srcH } };
    // The box fills the frame so exactly that no hundredth centres it: a hair smaller.
    w = down(w - 0.02);
    h = down(h - 0.02);
  }
  return { turns: edit.turns, crop: { cx: near(srcW / 2), cy: near(srcH / 2), w, h, angle, srcW, srcH } };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A `PhotoEdit` read from an untyped value (a server row), or null when it is not one. */
export function asPhotoEdit(value: unknown): PhotoEdit | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (o.turns !== 0 && o.turns !== 1 && o.turns !== 2 && o.turns !== 3) return null;
  if (o.crop === null || o.crop === undefined) return { turns: o.turns, crop: null };
  const c = o.crop as Record<string, unknown>;
  if (typeof c !== "object" || ![c.cx, c.cy, c.w, c.h, c.angle, c.srcW, c.srcH].every(isNum)) return null;
  return {
    turns: o.turns,
    crop: { cx: c.cx as number, cy: c.cy as number, w: c.w as number, h: c.h as number, angle: c.angle as number, srcW: c.srcW as number, srcH: c.srcH as number },
  };
}

/** A pending edit read from an untyped value: `{ status, turns, crop, error? }` (the stored row's shape) or `{ status, edit, error? }`. */
export function asPendingPhotoEdit(value: unknown): PendingPhotoEdit | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  if (o.status !== "rendering" && o.status !== "failed") return undefined;
  const edit = asPhotoEdit(o.edit ?? o);
  if (!edit) return undefined;
  return { status: o.status, edit, ...(typeof o.error === "string" ? { error: o.error } : {}) };
}

/**
 * Where the box sits on screen: the gap from the turned picture's left and top
 * edges to the box's upright outline, as whole percents of the picture.
 */
export function cropPlacement(edit: PhotoEdit, srcW: number, srcH: number): { left: number; top: number } {
  const crop = effectiveCrop(edit, srcW, srcH);
  const { ex, ey } = cropExtents(crop);
  // The source's gaps, clockwise from the top: top, right, bottom, left.
  const gaps = [crop.cy - ey, srcW - crop.cx - ex, srcH - crop.cy - ey, crop.cx - ex];
  // A quarter turn clockwise puts the source's left edge at the top of the screen.
  const onScreen = (i: number) => Math.max(0, gaps[(i - edit.turns + 4) % 4]);
  const shown = turnedSize(edit.turns, srcW, srcH);
  return {
    left: Math.round((100 * onScreen(3)) / shown.w),
    top: Math.round((100 * onScreen(0)) / shown.h),
  };
}

/** What a screen reader hears about the box: its tilt, the size it will keep, and where it sits. */
export function describeCrop(edit: PhotoEdit, srcW: number, srcH: number): string {
  const crop = effectiveCrop(edit, srcW, srcH);
  const out = outputSize(edit, srcW, srcH);
  const angle = Math.round(normalizeAngle(crop.angle));
  const at = cropPlacement(edit, srcW, srcH);
  return `Tilted ${angle}°, ${out.w} by ${out.h} pixels, ${at.left}% from the left and ${at.top}% from the top.`;
}
