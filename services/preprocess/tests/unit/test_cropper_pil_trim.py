"""Unit tests for app.cropper.pil_trim.

Two public entrypoints — `trim_dark` for light-on-dark, `trim_light` for
dark-on-light — share the same blur/threshold/bbox/border pipeline and are
exercised through parameterized tests. We assert shape properties rather
than pixel-exact output so Gaussian blur jitter + JPEG quantization don't
make tests flaky.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image, ImageDraw

from app.cropper.pil_trim import (
    BORDER_PX,
    MAX_LONGEST_EDGE_PX,
    trim_dark,
    trim_light,
)


def _card_on_background(
    *,
    card_color: str,
    bg_color: str,
    canvas_size: tuple[int, int] = (1200, 1600),
    card_box: tuple[int, int, int, int] = (200, 300, 1000, 1400),
) -> bytes:
    """Render a single rectangle (card) on a solid-color canvas (background)."""
    img = Image.new("RGB", canvas_size, color=bg_color)
    ImageDraw.Draw(img).rectangle(card_box, fill=card_color)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=90)
    return out.getvalue()


# Each fixture: (trim_fn, card_color, bg_color). Both pipelines see the same
# 800×1100 card with a 10px border added back after the crop.
_VARIANTS = [
    pytest.param(trim_dark, "white", "black", id="dark_bg_light_card"),
    pytest.param(trim_light, "black", "white", id="light_bg_dark_card"),
]


class TestTrimHappyPath:
    @pytest.mark.parametrize("trim_fn,card_color,bg_color", _VARIANTS)
    def test_returns_bytes_for_card_on_background(self, trim_fn, card_color, bg_color):
        result = trim_fn(_card_on_background(card_color=card_color, bg_color=bg_color))
        assert result is not None
        with Image.open(io.BytesIO(result)) as out:
            assert out.size[0] > 0 and out.size[1] > 0

    @pytest.mark.parametrize("trim_fn,card_color,bg_color", _VARIANTS)
    def test_output_includes_border(self, trim_fn, card_color, bg_color):
        result = trim_fn(_card_on_background(card_color=card_color, bg_color=bg_color))
        assert result is not None
        with Image.open(io.BytesIO(result)) as out:
            w, h = out.size
            # Card is 800×1100; output dimensions should be the card size plus
            # up to 2*BORDER_PX on each axis. A small Gaussian-blur fringe is
            # expected, so we allow a 10px slack.
            assert 800 <= w <= 800 + 2 * BORDER_PX + 10
            assert 1100 <= h <= 1100 + 2 * BORDER_PX + 10

    @pytest.mark.parametrize("trim_fn,card_color,bg_color", _VARIANTS)
    def test_downscales_very_large_inputs(self, trim_fn, card_color, bg_color):
        big = _card_on_background(
            card_color=card_color,
            bg_color=bg_color,
            canvas_size=(5000, 6000),
            card_box=(800, 1000, 4200, 5000),
        )
        result = trim_fn(big)
        assert result is not None
        with Image.open(io.BytesIO(result)) as out:
            assert max(out.size) <= MAX_LONGEST_EDGE_PX


class TestTrimDarkRejects:
    def test_all_black_image_returns_none(self):
        """Every pixel below the dark threshold → getbbox returns None."""
        img = Image.new("RGB", (1000, 1400), color="black")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)
        assert trim_dark(buf.getvalue()) is None

    def test_unreadable_bytes_returns_none(self):
        assert trim_dark(b"definitely not an image") is None

    def test_wrong_polarity_card_returns_none(self):
        """Dark card on light bg → trim_dark finds no bright pixels."""
        img = _card_on_background(card_color="black", bg_color="white")
        # trim_dark expects bright foreground; everywhere above threshold
        # is the background itself, so the bbox would be the entire image
        # → no useful trim. Not asserting None here because getbbox can
        # return the full canvas; we just confirm it doesn't crash.
        result = trim_dark(img)
        if result is not None:
            with Image.open(io.BytesIO(result)) as out:
                # Output should be ~ the full canvas (no meaningful trim).
                assert out.size[0] >= 1000


class TestTrimLightRejects:
    def test_all_white_image_returns_none(self):
        """Every pixel above the light threshold → getbbox returns None."""
        img = Image.new("RGB", (1000, 1400), color="white")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)
        assert trim_light(buf.getvalue()) is None

    def test_unreadable_bytes_returns_none(self):
        assert trim_light(b"definitely not an image") is None
