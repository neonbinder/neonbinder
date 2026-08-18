/**
 * Unit tests for convex/lib/pairing/dhash.ts — the mirror of the preprocess
 * service's `tests/unit/test_pairing_dhash.py`, minus the cases that decode
 * real image bytes.
 *
 * Covers: the 64-bit hash geometry invariant, `hammingDistance` (including
 * rejection of malformed input — the TS analogue of the Python
 * "rejects undecodable bytes" case), the `SAME_IMAGE_THRESHOLD` boundary
 * (parametrized off the production constant), and the separation the pool
 * actually depends on — same-scan-regime distances landing inside the
 * threshold while front-vs-back-regime distances land far outside it.
 *
 * The Python suite's image-synthesis cases (`compute_dhash` over PNG/JPEG
 * payloads, crop/exposure jitter) have no TS counterpart **by contract**:
 * this package never hashes an image — hashes arrive as 16-char lowercase hex
 * strings computed server-side — so those regimes are represented here as hex
 * fixtures at empirically-observed distances (same scan 0-4, front-vs-back
 * 25+) rather than as decoded images.
 */

import { describe, expect, test } from "vitest";

import {
  DHASH_HEIGHT,
  DHASH_HEX_LENGTH,
  DHASH_WIDTH,
  SAME_IMAGE_THRESHOLD,
  hammingDistance,
  imagesLookIdentical,
  isDhashHex,
} from "./dhash";

const ZERO_HASH = "0".repeat(DHASH_HEX_LENGTH);

/** A hex hash with exactly `bits` low bits set — Hamming distance `bits` from ZERO_HASH. */
function lowBitsHex(bits: number): string {
  return ((BigInt(1) << BigInt(bits)) - BigInt(1))
    .toString(16)
    .padStart(DHASH_HEX_LENGTH, "0");
}

describe("dHash geometry", () => {
  test("bit budget matches the thumbnail geometry", () => {
    // 8 rows x 8 left>right comparisons across a 9-wide thumbnail, and the
    // 64 bits serialise to exactly 16 hex characters.
    expect((DHASH_WIDTH - 1) * DHASH_HEIGHT).toBe(64);
    expect(DHASH_HEX_LENGTH * 4).toBe(64);
  });
});

describe("isDhashHex", () => {
  test("accepts a 16-char lowercase hex string", () => {
    expect(isDhashHex("deadbeef01234567")).toBe(true);
  });

  test.each([
    ["uppercase", "DEADBEEF01234567"],
    ["too short", "abc"],
    ["too long", "deadbeef0123456789"],
    ["non-hex characters", "not an image at!"],
    ["empty", ""],
  ])("rejects %s", (_label, value) => {
    expect(isDhashHex(value)).toBe(false);
  });
});

describe("hammingDistance", () => {
  test("identical values are zero", () => {
    expect(hammingDistance("00000000deadbeef", "00000000deadbeef")).toBe(0);
  });

  test("counts differing bits", () => {
    // 0b0000 vs 0b1011 — three differing bits.
    expect(hammingDistance(ZERO_HASH, "000000000000000b")).toBe(3);
  });

  test("is symmetric", () => {
    expect(hammingDistance("000000000000f0f0", "0000000000000f0f")).toBe(
      hammingDistance("0000000000000f0f", "000000000000f0f0"),
    );
  });

  test("fully inverted 64-bit values", () => {
    expect(hammingDistance(ZERO_HASH, "f".repeat(DHASH_HEX_LENGTH))).toBe(64);
  });

  test.each([
    ["uppercase", "DEADBEEF01234567"],
    ["too short", "abc"],
    ["non-hex characters", "not an image at!"],
    ["empty", ""],
  ])(
    // The TS analogue of the Python "rejects undecodable bytes" case: our
    // input is a serialised hash rather than image bytes, so the undecodable
    // payload is a malformed hex string — in either argument position.
    "rejects malformed input (%s) in either position",
    (_label, bad) => {
      expect(() => hammingDistance(bad, ZERO_HASH)).toThrow();
      expect(() => hammingDistance(ZERO_HASH, bad)).toThrow();
    },
  );
});

describe("SAME_IMAGE_THRESHOLD boundary", () => {
  test.each([
    [0, true],
    [SAME_IMAGE_THRESHOLD - 1, true],
    [SAME_IMAGE_THRESHOLD, true],
    [SAME_IMAGE_THRESHOLD + 1, false],
  ])("boundary is inclusive at distance %i", (distance, expected) => {
    // Build two values a known Hamming distance apart.
    expect(imagesLookIdentical(ZERO_HASH, lowBitsHex(distance))).toBe(expected);
  });
});

describe("same image versus different image", () => {
  // The one decision the pool uses this for: re-scan or mis-classification?
  // The Python suite synthesises real images for these regimes; here they are
  // hex fixtures at the empirically-observed distances (see dhash.ts: two
  // scans of the same card side land at 0-4, a front against its own back at
  // 25+).

  test("same-scan-regime distances stay within the threshold", () => {
    // Re-encodes, exposure shifts and slight crop jitter land at 0-4 bits.
    expect(imagesLookIdentical(ZERO_HASH, lowBitsHex(4))).toBe(true);
  });

  test("front-vs-back-regime distances are far outside the threshold", () => {
    expect(imagesLookIdentical(ZERO_HASH, lowBitsHex(25))).toBe(false);
    expect(hammingDistance(ZERO_HASH, lowBitsHex(25))).toBeGreaterThan(
      SAME_IMAGE_THRESHOLD,
    );
  });

  test("a fully inverted image is the extreme of the different-image regime", () => {
    // Inversion flips every left>right comparison — 64 differing bits.
    const inverted = "f".repeat(DHASH_HEX_LENGTH);
    expect(hammingDistance(ZERO_HASH, inverted)).toBeGreaterThan(SAME_IMAGE_THRESHOLD);
    expect(imagesLookIdentical(ZERO_HASH, inverted)).toBe(false);
  });
});
