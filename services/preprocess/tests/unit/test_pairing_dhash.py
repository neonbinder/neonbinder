"""Unit tests for app.pairing.dhash.

Covers: hash width/determinism, `hamming_distance`, the
`SAME_IMAGE_THRESHOLD` boundary (parametrized off the production constant),
and the separation the pool actually depends on — two encodings/crops of the
same scan landing inside the threshold while a genuinely different image lands
far outside it.

All images are synthesized in-test with PIL. Nothing here is cross-validated
against a TypeScript-produced hash: Pillow's LANCZOS and sharp's Lanczos3 are
different kernels, so the bit patterns legitimately differ. The threshold, not
the exact value, is the contract.
"""

from __future__ import annotations

import math
from io import BytesIO

import pytest
from PIL import Image

from app.pairing.dhash import (
    DHASH_HEIGHT,
    DHASH_WIDTH,
    SAME_IMAGE_THRESHOLD,
    compute_dhash,
    hamming_distance,
    images_look_identical,
)

# Card-shaped and large enough that a few pixels of crop jitter is a small
# fraction of the frame, as it would be on a real re-scan.
IMAGE_SIZE = (180, 252)


def _smooth_card(phase: float = 0.0, brightness: int = 0, size=IMAGE_SIZE) -> Image.Image:
    """A spatially smooth grayscale pattern standing in for a card face.

    Smoothness matters: a dHash of pure noise is destroyed by a one-pixel
    crop, which would make the "same scan, slightly different framing" case
    untestable for reasons that have nothing to do with the hash. Real card
    images are smooth at the 9x8 scale the hash reduces them to.
    """
    width, height = size
    img = Image.new("L", size)
    pixels = []
    for y in range(height):
        for x in range(width):
            value = 128 + 100 * math.sin(x / 23.0 + phase) * math.cos(y / 31.0 + phase)
            pixels.append(max(0, min(255, int(value) + brightness)))
    img.putdata(pixels)
    return img


def _encode(img: Image.Image, fmt: str = "PNG", **kwargs) -> bytes:
    buf = BytesIO()
    img.save(buf, format=fmt, **kwargs)
    return buf.getvalue()


class TestComputeDHash:
    def test_produces_a_64_bit_value(self):
        value = compute_dhash(_encode(_smooth_card()))
        assert 0 <= value < 2**64

    def test_bit_budget_matches_the_thumbnail_geometry(self):
        # 8 rows x 8 left>right comparisons across a 9-wide thumbnail.
        assert (DHASH_WIDTH - 1) * DHASH_HEIGHT == 64

    def test_is_deterministic(self):
        payload = _encode(_smooth_card())
        assert compute_dhash(payload) == compute_dhash(payload)

    def test_accepts_jpeg_as_well_as_png(self):
        card = _smooth_card()
        assert compute_dhash(_encode(card, "JPEG", quality=90)) < 2**64

    def test_rejects_undecodable_bytes(self):
        with pytest.raises(Exception):  # noqa: B017 - Pillow's exact type is not the contract
            compute_dhash(b"not an image")


class TestHammingDistance:
    def test_identical_values_are_zero(self):
        assert hamming_distance(0xDEADBEEF, 0xDEADBEEF) == 0

    def test_counts_differing_bits(self):
        assert hamming_distance(0b0000, 0b1011) == 3

    def test_is_symmetric(self):
        assert hamming_distance(0xF0F0, 0x0F0F) == hamming_distance(0x0F0F, 0xF0F0)

    def test_fully_inverted_64_bit_values(self):
        assert hamming_distance(0, (1 << 64) - 1) == 64


class TestSameImageThreshold:
    @pytest.mark.parametrize(
        "distance,expected",
        [
            (0, True),
            (SAME_IMAGE_THRESHOLD - 1, True),
            (SAME_IMAGE_THRESHOLD, True),
            (SAME_IMAGE_THRESHOLD + 1, False),
        ],
    )
    def test_boundary_is_inclusive(self, distance, expected):
        # Build two values a known Hamming distance apart.
        assert images_look_identical(0, (1 << distance) - 1) is expected


class TestSameImageVersusDifferentImage:
    """The one decision the pool uses this for: re-scan or mis-classification?"""

    def test_same_pixels_reencoded_stay_within_threshold(self):
        card = _smooth_card()
        png = compute_dhash(_encode(card, "PNG"))
        jpeg = compute_dhash(_encode(card, "JPEG", quality=75))
        assert hamming_distance(png, jpeg) <= SAME_IMAGE_THRESHOLD

    def test_same_scan_with_exposure_shift_stays_within_threshold(self):
        base = compute_dhash(_encode(_smooth_card()))
        brighter = compute_dhash(_encode(_smooth_card(brightness=20)))
        assert hamming_distance(base, brighter) <= SAME_IMAGE_THRESHOLD

    def test_same_scan_with_slight_crop_jitter_stays_within_threshold(self):
        card = _smooth_card()
        cropped = card.crop((4, 4, card.width - 4, card.height - 4))
        base = compute_dhash(_encode(card))
        rescan = compute_dhash(_encode(cropped))
        assert hamming_distance(base, rescan) <= SAME_IMAGE_THRESHOLD

    def test_inverted_image_is_far_outside_the_threshold(self):
        # Inversion flips every left>right comparison, which is the extreme of
        # the "different image" regime a front vs. its own back sits in.
        card = _smooth_card()
        inverted = card.point(lambda v: 255 - v)
        distance = hamming_distance(compute_dhash(_encode(card)), compute_dhash(_encode(inverted)))
        assert distance > SAME_IMAGE_THRESHOLD

    def test_structurally_different_image_is_outside_the_threshold(self):
        base = compute_dhash(_encode(_smooth_card(phase=0.0)))
        other = compute_dhash(_encode(_smooth_card(phase=1.9)))
        assert hamming_distance(base, other) > SAME_IMAGE_THRESHOLD

    def test_front_and_back_style_images_separate(self):
        # A "front" (broad smooth photo) against a "back" (dense horizontal
        # rules, the way a stat table reduces at 9x8).
        front = _smooth_card()
        back = Image.new("L", IMAGE_SIZE, color=240)
        for y in range(0, IMAGE_SIZE[1], 6):
            for x in range(0, IMAGE_SIZE[0], 4):
                back.putpixel((x, y), 20)
        distance = hamming_distance(compute_dhash(_encode(front)), compute_dhash(_encode(back)))
        assert distance > SAME_IMAGE_THRESHOLD
