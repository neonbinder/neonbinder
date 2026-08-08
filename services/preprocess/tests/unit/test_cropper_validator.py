"""Unit tests for app.cropper.validator.

Covers each rejection path (too small, bad aspect, area fraction, blank)
and the happy path. Fixtures are generated in-memory with PIL so tests
are self-contained.
"""

from __future__ import annotations

import io
import random

from PIL import Image

from app.cropper.validator import (
    ASPECT_TOLERANCE,
    CARD_ASPECT_PORTRAIT,
    MIN_SIDE_PX,
    is_plausible_crop,
)


def _jpeg_of_size(w: int, h: int, *, color: str = "white", noise: bool = True) -> bytes:
    """Emit a JPEG of the requested size.

    Without `noise`, the image is a uniform color — useful for testing the
    blank-detection path. With `noise`, random pixel values make stddev
    comfortably exceed the blank threshold.
    """
    if noise:
        rng = random.Random(42)
        raw = bytes(rng.randint(0, 255) for _ in range(w * h * 3))
        img = Image.frombytes("RGB", (w, h), raw)
    else:
        img = Image.new("RGB", (w, h), color=color)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=85)
    return out.getvalue()


def _portrait_card(scale: int = 1) -> bytes:
    # Standard trading-card portrait ratio: 2.5:3.5.
    return _jpeg_of_size(500 * scale, 700 * scale)


def _landscape_card(scale: int = 1) -> bytes:
    return _jpeg_of_size(700 * scale, 500 * scale)


class TestPlausibleCrop:
    def test_portrait_card_passes(self):
        result = is_plausible_crop(_portrait_card())
        assert result.ok, result.reason

    def test_landscape_card_passes(self):
        result = is_plausible_crop(_landscape_card())
        assert result.ok, result.reason

    def test_too_small_rejected(self):
        tiny = _jpeg_of_size(MIN_SIDE_PX - 50, MIN_SIDE_PX - 50)
        result = is_plausible_crop(tiny)
        assert not result.ok
        assert "too small" in (result.reason or "")

    def test_wrong_aspect_rejected(self):
        # Square image — ~40% off both portrait and landscape ratios.
        square = _jpeg_of_size(500, 500)
        result = is_plausible_crop(square)
        assert not result.ok
        assert "aspect" in (result.reason or "")

    def test_aspect_just_inside_tolerance_passes(self):
        # 15% tolerance means we accept up to ±15% of 0.714 → 0.607 to 0.821.
        # Construct 450x700 → ratio 0.643 → ~10% off portrait, inside tol.
        inside = _jpeg_of_size(450, 700)
        result = is_plausible_crop(inside)
        assert result.ok, result.reason

    def test_aspect_just_outside_tolerance_rejected(self):
        # 350x700 → ratio 0.5 → 30% off portrait, outside tolerance.
        outside = _jpeg_of_size(350, 700)
        result = is_plausible_crop(outside)
        assert not result.ok

    def test_blank_image_rejected(self):
        # Uniform-white image — stddev ~= 0.
        blank = _jpeg_of_size(500, 700, color="white", noise=False)
        result = is_plausible_crop(blank)
        assert not result.ok
        assert "near-uniform" in (result.reason or "")

    def test_unreadable_bytes_rejected(self):
        result = is_plausible_crop(b"not an image at all")
        assert not result.ok
        assert "cannot open" in (result.reason or "")

    def test_area_fraction_gate(self):
        # 500x700 card out of a 2000x2800 source → ~6% — rejected (< 10%).
        # Kept deliberately small to avoid burning seconds on random-byte
        # generation for a test whose point is the fraction math, not size.
        source = _jpeg_of_size(2000, 2800)
        small_crop = _portrait_card()  # 500x700
        result = is_plausible_crop(small_crop, source_area_bytes=source)
        assert not result.ok
        assert "covers only" in (result.reason or "")

    def test_area_fraction_passes_when_large_enough(self):
        # 500x700 / 1000x1400 = 25% → passes.
        source = _jpeg_of_size(1000, 1400)
        crop = _portrait_card()
        result = is_plausible_crop(crop, source_area_bytes=source)
        assert result.ok, result.reason

    def test_tolerance_sanity(self):
        # Tolerance is defined at module level; if someone changes it, the
        # inside/outside tests above might need updates. This test protects
        # against accidental changes to ASPECT_TOLERANCE that break the
        # public meaning of "plausible".
        assert 0.05 <= ASPECT_TOLERANCE <= 0.25
        assert 0.6 < CARD_ASPECT_PORTRAIT < 0.8
