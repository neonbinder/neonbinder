/**
 * Perceptual difference-hash (dHash) distance helpers.
 *
 * **This module never hashes an image.** The Python port computes the hash
 * itself (Pillow: 9x8 grayscale thumbnail, each pixel compared against its
 * right-hand neighbour, 64 bits = 8 comparisons x 8 rows); the default Convex
 * runtime has no image decoding and does not need any. Hashes arrive here as
 * **16-character lowercase hex strings** computed server-side, and this
 * module only measures distances between them.
 *
 * Two scans of the same physical card side produce near-identical hashes
 * despite minor crop, rotation and lighting differences, while genuinely
 * different images (a front against its own back) differ by a large Hamming
 * distance.
 *
 * The pool uses this for exactly one decision: when two images of the same
 * card both arrive labelled the same side, was that a deliberate re-scan
 * (same image, evict the stale entry) or a mis-classification (different
 * image, flip the side so the two pair instead of one clobbering the other)?
 *
 * **Values are not bit-identical across hashers.** sharp resizes with
 * Lanczos3 through libvips; Pillow's LANCZOS uses a different kernel support
 * and rounding, so individual comparisons near a tie can flip. That is fine
 * and expected: nothing persists a hash across the hasher boundary, all
 * hashes compared within one batch come from the same server-side hasher, and
 * the threshold below has ~15 bits of headroom. Never cross-validate a hash
 * from one hasher against a value produced by another.
 */

/** Thumbnail width: 9 wide so each of the 8 rows yields 8 left>right comparisons = 64 bits. */
export const DHASH_WIDTH = 9;

/** Thumbnail height — see `DHASH_WIDTH`. */
export const DHASH_HEIGHT = 8;

/** A 64-bit hash serialises to exactly 16 lowercase hex characters. */
export const DHASH_HEX_LENGTH = 16;

/**
 * Hamming distance at or below which two dHashes are treated as the same
 * physical image. Empirically, two scans of the same card side land at 0-4
 * even with visible crop and exposure differences, while a front against its
 * own back is 25+. 10 sits in the empty middle of that gap, tolerant enough
 * to survive the Lanczos-kernel differences noted in the module docstring
 * without ever reaching the front-vs-back regime.
 */
export const SAME_IMAGE_THRESHOLD = 10;

/** The wire format for a hash: exactly 16 lowercase hex characters. */
const DHASH_HEX_RE = /^[0-9a-f]{16}$/;

/**
 * True when `value` is a well-formed serialised dHash (16 lowercase hex
 * chars). The pool uses this to degrade gracefully when a hasher hands back
 * something malformed, mirroring the Python rule that a hash failure must
 * never fail a batch.
 */
export function isDhashHex(value: string): boolean {
  return DHASH_HEX_RE.test(value);
}

/** Parse a validated hex hash into a bigint, throwing on malformed input. */
function parseDhashHex(hex: string): bigint {
  if (!isDhashHex(hex)) {
    throw new Error(
      `pairing: not a dHash hex string (expected ${DHASH_HEX_LENGTH} lowercase hex chars): ${JSON.stringify(hex)}`,
    );
  }
  return BigInt("0x" + hex);
}

/**
 * Number of differing bits between two hashes (0 = identical).
 *
 * The original TS hand-rolled a shift-and-count loop because JS `bigint` has
 * no popcount; Python 3.12 used `int.bit_count()`. This port XORs the two
 * values as bigints and counts set bits with Kernighan's trick (`x &= x - 1`
 * clears the lowest set bit), bounded at 64 iterations.
 *
 * Throws on input that is not a 16-char lowercase hex string — hashes are
 * produced by our own server-side hasher, so malformed input is a programming
 * error, not a runtime condition to absorb (the pool validates separately via
 * `isDhashHex` where degradation is wanted).
 */
export function hammingDistance(aHex: string, bHex: string): number {
  const ZERO = BigInt(0);
  const ONE = BigInt(1);
  let diff = parseDhashHex(aHex) ^ parseDhashHex(bHex);
  let count = 0;
  while (diff !== ZERO) {
    diff &= diff - ONE;
    count += 1;
  }
  return count;
}

/** True when two dHashes are within `SAME_IMAGE_THRESHOLD` of each other. */
export function imagesLookIdentical(aHex: string, bHex: string): boolean {
  return hammingDistance(aHex, bHex) <= SAME_IMAGE_THRESHOLD;
}
