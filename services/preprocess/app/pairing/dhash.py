"""Perceptual difference-hash (dHash) — port of script-frontend's imageHash.ts.

The image is reduced to a 9x8 grayscale thumbnail and each pixel is compared
against its right-hand neighbour, yielding 64 bits (8 comparisons x 8 rows).
Two scans of the same physical card side produce near-identical hashes despite
minor crop, rotation and lighting differences, while genuinely different images
(a front against its own back) differ by a large Hamming distance.

The pool uses this for exactly one decision: when two images of the same card
both arrive labelled the same side, was that a deliberate re-scan (same image,
evict the stale entry) or a mis-classification (different image, flip the side
so the two pair instead of one clobbering the other)?

Cost is trivial — one decode down to a 72-byte thumbnail — so this carries none
of the memory profile of the SAM/torch path in `app.cropper`. Pillow is already
a runtime dependency; this port adds none.

**Values will not be bit-identical to the TypeScript.** sharp resizes with
Lanczos3 through libvips; Pillow's LANCZOS uses a different kernel support and
rounding, so individual comparisons near a tie can flip. That is fine and
expected: nothing persists a hash across the language boundary, and the
threshold below has ~15 bits of headroom. Never cross-validate a Python hash
against a TypeScript-produced value.
"""

from __future__ import annotations

import logging
from io import BytesIO

from PIL import Image

logger = logging.getLogger(__name__)

# 9 wide so each of the 8 rows yields 8 left>right comparisons = 64 bits.
DHASH_WIDTH = 9
DHASH_HEIGHT = 8

# Hamming distance at or below which two dHashes are treated as the same
# physical image. Empirically, two scans of the same card side land at 0-4 even
# with visible crop and exposure differences, while a front against its own back
# is 25+. 10 sits in the empty middle of that gap, tolerant enough to survive
# the Lanczos-kernel difference noted in the module docstring without ever
# reaching the front-vs-back regime.
SAME_IMAGE_THRESHOLD = 10


def compute_dhash(image_bytes: bytes) -> int:
    """Compute the 64-bit dHash of an encoded image.

    Takes bytes rather than the source's file path: every other entry point in
    this service (`app.cropper`, `app.classify`, `app.orient`) is bytes-in, and
    the zip job under NEO-149 holds members in memory rather than on disk.

    Raises whatever Pillow raises on an undecodable payload; callers that want
    graceful degradation wrap this in their `ImageHasher` callback, which is
    allowed to return None.
    """
    with Image.open(BytesIO(image_bytes)) as img:
        thumbnail = img.convert("L").resize(
            (DHASH_WIDTH, DHASH_HEIGHT),
            Image.Resampling.LANCZOS,
        )
    # Mode "L" packs one byte per pixel, row-major, so index (row, col) is
    # row * DHASH_WIDTH + col — the same indexing the sharp raw buffer used.
    data = thumbnail.tobytes()

    value = 0
    bit = 0
    for row in range(DHASH_HEIGHT):
        for col in range(DHASH_WIDTH - 1):
            left = data[row * DHASH_WIDTH + col]
            right = data[row * DHASH_WIDTH + col + 1]
            if left > right:
                value |= 1 << bit
            bit += 1
    return value


def hamming_distance(a: int, b: int) -> int:
    """Number of differing bits between two hashes (0 = identical).

    The source hand-rolled a shift-and-count loop because JS `bigint` has no
    popcount; Python 3.12 has `int.bit_count()`, which is the same result in
    one call.
    """
    return (a ^ b).bit_count()


def images_look_identical(a: int, b: int) -> bool:
    """True when two dHashes are within `SAME_IMAGE_THRESHOLD` of each other."""
    return hamming_distance(a, b) <= SAME_IMAGE_THRESHOLD
