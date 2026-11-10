/**
 * NEO-481 — the pure half of a hand photo edit (turn + crop): the caps, the
 * checks a validator cannot express, the opening state, and the wire shapes
 * to and from the preprocess service. Dependency-free on purpose, so the
 * default-runtime settle (`placeholderPipeline.ts`), the row mutations
 * (`photoEditRows.ts`) and the Node adapter (`adapters/preprocess.ts`) all
 * read one copy.
 *
 * The edit parameters (`PhotoEdit`) are the contract every row builds to
 * (todos/neo-481-plan.md, "The edit parameters"): `turns` quarter turns
 * clockwise, applied last; `crop` a box (centre, size, angle) in the source
 * frame `srcW` x `srcH`, or null for the whole source.
 */

/** Scan-form renders one scan may have reserved (render + re-read are paid). */
export const PLACEHOLDER_MAX_IMAGE_EDITS = 10;
/** Copy-photo edit rows (`source: "edit"`) one collector may start in an hour. */
export const MAX_COPY_PHOTO_EDITS_PER_HOUR = 60;
/**
 * How long an accepted edit may stay "rendering" before another save may take
 * its place. A cold fast instance answers in about 40 s; past this the render
 * was lost (a crashed action), and the collector must not be stuck behind it.
 */
export const PHOTO_EDIT_RENDER_STALE_MS = 3 * 60 * 1000;
/**
 * Renders one collector may send the preprocess service in an hour, scans and
 * copies together (`photoEditTickets`). Renders run outside the
 * capacity-pinned pipeline pool, so this is what keeps one account from
 * starving everyone's batches.
 */
export const MAX_PHOTO_EDIT_RENDERS_PER_HOUR = 60;
/** Renders one collector may have in flight at once (unsettled, not stale). */
export const MAX_PHOTO_EDIT_RENDERS_IN_FLIGHT = 4;
/** The rate window, and how long a ticket is kept before the sweep. */
export const PHOTO_EDIT_TICKET_WINDOW_MS = 60 * 60 * 1000;
/**
 * The deployment-wide window in which a second edit-renderer warm-up is
 * skipped: the fast warm-up's own fetch budget, the longest one can be in flight.
 */
export const EDIT_WARMUP_WINDOW_MS = 60_000;
/** The largest source side we accept a crop frame for (a 64 MP scan is ~8000 px). */
export const MAX_EDIT_SOURCE_SIDE = 50_000;

export type PhotoEditCrop = {
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number;
  srcW: number;
  srcH: number;
};
export type PhotoTurns = 0 | 1 | 2 | 3;
export type PhotoEdit = { turns: PhotoTurns; crop: PhotoEditCrop | null };

/** What the service is sent: the same numbers, snake_case like every other field on the wire. */
export type PhotoEditWire = {
  turns: PhotoTurns;
  crop: null | { cx: number; cy: number; w: number; h: number; angle: number; src_w: number; src_h: number };
};

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const positiveInt = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= MAX_EDIT_SOURCE_SIDE;

/**
 * Half-extents of a box turned by `angle` degrees: how far its corners reach
 * from the centre along x and y. The same for a turn either way, so the
 * inside-the-frame check does not depend on the sign convention.
 */
export function cropExtents(crop: Pick<PhotoEditCrop, "w" | "h" | "angle">): { ex: number; ey: number } {
  const rad = (crop.angle * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  return { ex: (crop.w / 2) * c + (crop.h / 2) * s, ey: (crop.w / 2) * s + (crop.h / 2) * c };
}

/**
 * Float slack on the inside-the-frame check, as a fraction of the frame's long
 * side. A whole-frame or fitted box sits exactly on the edges, so it must
 * pass; anything we accept must also pass the service's own check (0.5 px in
 * the source's pixels, after scaling the box into it), so the slack is kept
 * far below that.
 */
const FRAME_SLACK = 1e-6;

/**
 * Why this edit cannot be rendered, in the collector's words, or null when it
 * can. Every number finite, the size positive, the frame whole pixels, the
 * angle in (-180, 180], and the turned box inside the frame (to float slack;
 * the editor clamps its box to the frame). The box staying inside the frame
 * is also what keeps a stored-mode crop shrink-only: there, the frame IS the
 * stored picture.
 */
export function photoEditProblem(edit: PhotoEdit): string | null {
  if (![0, 1, 2, 3].includes(edit.turns)) return "That turn isn't one we can make.";
  const crop = edit.crop;
  if (crop === null) return null;
  const numbers = [crop.cx, crop.cy, crop.w, crop.h, crop.angle, crop.srcW, crop.srcH];
  if (!numbers.every(finite)) return "That crop box isn't a box we can cut.";
  if (!positiveInt(crop.srcW) || !positiveInt(crop.srcH)) return "That crop box isn't a box we can cut.";
  if (!(crop.w > 0) || !(crop.h > 0)) return "That crop box is too small to cut.";
  if (!(crop.angle > -180 && crop.angle <= 180)) return "That crop box is turned past what we can cut.";
  const { ex, ey } = cropExtents(crop);
  const tol = Math.max(crop.srcW, crop.srcH) * FRAME_SLACK;
  if (crop.cx - ex < -tol || crop.cx + ex > crop.srcW + tol || crop.cy - ey < -tol || crop.cy + ey > crop.srcH + tol) {
    return "That crop box reaches past the edge of the photo.";
  }
  return null;
}

/**
 * The editor's opening turns for a scan with no edit yet (contract rule Q5):
 * the pipeline stores `rotationDegrees` counter-clockwise, the edit counts
 * quarter turns clockwise. So the first save of an untouched scan reproduces
 * today's output.
 */
export function openingTurns(rotationDegrees: number | undefined): PhotoTurns {
  const ccw = finite(rotationDegrees) ? rotationDegrees : 0;
  const cw = (((360 - ccw) % 360) + 360) % 360;
  return (Math.round(cw / 90) % 4) as PhotoTurns;
}

/** The edit as the service is sent it. */
export function photoEditToWire(edit: PhotoEdit): PhotoEditWire {
  const crop = edit.crop;
  return {
    turns: edit.turns,
    crop:
      crop === null
        ? null
        : { cx: crop.cx, cy: crop.cy, w: crop.w, h: crop.h, angle: crop.angle, src_w: crop.srcW, src_h: crop.srcH },
  };
}

/**
 * `/process-entry`'s `crop_box`, narrowed field by field into the stored
 * shape, or undefined. Never throws and never spreads the service's object:
 * it is written inside the settle, where a validator refusal would strand
 * the batch (the NEO-170 rule). Accepts `src_w`/`src_h` (the wire's case)
 * or `srcW`/`srcH`. Anything missing, not finite, or outside the frame
 * drops the whole box.
 */
export function parseCropBox(value: unknown): PhotoEditCrop | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const box: PhotoEditCrop = {
    cx: raw.cx as number,
    cy: raw.cy as number,
    w: raw.w as number,
    h: raw.h as number,
    angle: raw.angle as number,
    srcW: (raw.src_w ?? raw.srcW) as number,
    srcH: (raw.src_h ?? raw.srcH) as number,
  };
  if (!Object.values(box).every(finite)) return undefined;
  return photoEditProblem({ turns: 0, crop: box }) === null ? box : undefined;
}

/** Two edits ask for the same picture. */
export function samePhotoEdit(a: PhotoEdit, b: PhotoEdit): boolean {
  if (a.turns !== b.turns) return false;
  if (a.crop === null || b.crop === null) return a.crop === b.crop;
  return (Object.keys(a.crop) as Array<keyof PhotoEditCrop>).every((k) => a.crop![k] === b.crop![k]);
}

/** Just the parameters, off a stored or pending edit (drops version, status and the rest). */
export function photoEditOf(edit: PhotoEdit): PhotoEdit {
  return { turns: edit.turns, crop: edit.crop === null ? null : { ...pickCrop(edit.crop) } };
}

function pickCrop(c: PhotoEditCrop): PhotoEditCrop {
  return { cx: c.cx, cy: c.cy, w: c.w, h: c.h, angle: c.angle, srcW: c.srcW, srcH: c.srcH };
}
