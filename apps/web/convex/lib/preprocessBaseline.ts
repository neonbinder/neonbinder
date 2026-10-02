/**
 * The FAST role's escalation hints, and the narrowers both runtimes share
 * (NEO-315, D4).
 *
 * When the FAST preprocess service declines a card (`needs_escalation: true`)
 * it has already paid for two things the HEAVY service would otherwise redo
 * from scratch: a Vision text-orientation read of the image (the `baseline`)
 * and the perceptual hash (`dhash`). The decline body now carries both, Convex
 * keeps them on the image row, and the heavy `/process-entry` request hands
 * them back so the heavy service can skip that work.
 *
 * Wire shape (snake_case, both optional, both nullable — an older service
 * revision omits them, and Convex must behave exactly as before when it does):
 *
 *   response (FAST decline) and request (HEAVY):
 *     baseline: { rotation_degrees: int, confidence: float, text_count: int } | null
 *     dhash:    string | null          // 16 lowercase hex
 *
 * Why this lives in `lib/` and not in `adapters/preprocess.ts`: that adapter is
 * a `"use node"` module, and the place that first reads a settled fast result
 * is the workpool completion in placeholderPipeline.ts, a default-runtime
 * mutation that cannot import a Node module. So the type, the validator and the
 * narrowers are here, pure, and the adapter re-exports them.
 *
 * Everything that crosses the boundary is narrowed, never trusted. A hint is
 * an optimisation: a malformed one is DROPPED (the heavy service recomputes),
 * never stored and never forwarded — forwarding garbage could make the heavy
 * request fail validation, which would fail the image terminally for the sake
 * of a shortcut.
 */

import { v } from "convex/values";

/** Vision's text-orientation read of the uncropped image, camelCased. */
export type PreprocessBaseline = {
  /** CCW rotation that makes the text upright. Always a quadrant. */
  rotationDegrees: number;
  /** Share of words that voted for the winning quadrant, 0..1. */
  orientConfidence: number;
  /** Words Vision found. */
  textCount: number;
};

/** The same, as it travels on the wire in both directions. */
export type PreprocessBaselineWire = {
  rotation_degrees: number;
  confidence: number;
  text_count: number;
};

/**
 * Convex validator for a stored or forwarded baseline — for a schema field or
 * an internal function's args. It checks the shape only; the value ranges are
 * `isPreprocessBaseline`'s job, which every producer runs first.
 */
export const preprocessBaselineValidator = v.object({
  rotationDegrees: v.number(),
  orientConfidence: v.number(),
  textCount: v.number(),
});

/** `orient.py` snaps every angle to a quadrant; nothing else is a real answer. */
const QUADRANTS = new Set([0, 90, 180, 270]);

/**
 * Upper bound on a believable word count. A card face carries hundreds of
 * words at most; this only exists so a corrupt value cannot ride along.
 */
const MAX_TEXT_COUNT = 100_000;

/** Same shape the pairing pass and `imageFieldsFromResult` accept. */
const DHASH_RE = /^[0-9a-f]{16}$/;

function isQuadrant(value: unknown): value is number {
  return typeof value === "number" && QUADRANTS.has(value);
}

function isConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isTextCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_TEXT_COUNT
  );
}

/** Is this a camelCase baseline whose every value is in range? */
export function isPreprocessBaseline(value: unknown): value is PreprocessBaseline {
  if (!value || typeof value !== "object") return false;
  const b = value as Record<string, unknown>;
  return isQuadrant(b.rotationDegrees) && isConfidence(b.orientConfidence) && isTextCount(b.textCount);
}

/**
 * Narrow the wire `baseline` off a `/process-entry` response to the camelCase
 * shape, or null when it is absent (an older service), null (the service had
 * none), or malformed in any field.
 */
export function parseWireBaseline(raw: unknown): PreprocessBaseline | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  const candidate = {
    rotationDegrees: w.rotation_degrees,
    orientConfidence: w.confidence,
    textCount: w.text_count,
  };
  return isPreprocessBaseline(candidate) ? candidate : null;
}

/** The camelCase baseline back to the wire shape for the heavy request. */
export function baselineToWire(baseline: PreprocessBaseline): PreprocessBaselineWire {
  return {
    rotation_degrees: baseline.rotationDegrees,
    confidence: baseline.orientConfidence,
    text_count: baseline.textCount,
  };
}

/** A 16-char lowercase hex dhash, or null. */
export function parseDhash(raw: unknown): string | null {
  return typeof raw === "string" && DHASH_RE.test(raw) ? raw : null;
}

/**
 * Read the escalation hints off a SETTLED fast result — the workpool's
 * `result.returnValue`, typed `unknown` because it crossed a serialization
 * boundary. That value is what `callProcessEntryFast` returned, so its
 * `baseline` is already camelCase; it is re-narrowed here regardless.
 *
 * Absent or malformed hints come back `undefined` (not null) so the result
 * spreads straight into optional schema fields and into
 * `callProcessEntryHeavy`'s optional args without a filter step.
 */
export function readEscalationHints(returnValue: unknown): {
  baseline?: PreprocessBaseline;
  dhash?: string;
} {
  if (!returnValue || typeof returnValue !== "object") return {};
  const body = returnValue as Record<string, unknown>;
  const hints: { baseline?: PreprocessBaseline; dhash?: string } = {};
  if (isPreprocessBaseline(body.baseline)) {
    const b = body.baseline;
    // Copy field by field so nothing extra rides along into a stored row.
    hints.baseline = {
      rotationDegrees: b.rotationDegrees,
      orientConfidence: b.orientConfidence,
      textCount: b.textCount,
    };
  }
  const dhash = parseDhash(body.dhash);
  if (dhash !== null) hints.dhash = dhash;
  return hints;
}
