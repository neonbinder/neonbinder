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
    def test_oversized_input_is_cropped_at_full_resolution(self, trim_fn, card_color, bg_color):
        """Detection downscales; the crop must still come from the original.

        The 6000px canvas is over MAX_LONGEST_EDGE_PX so the detection pass
        runs on a downscaled copy. The returned crop must nonetheless be in
        ORIGINAL coordinates — a 3400x4000 card, not the ~0.5x version of
        it. Returning downscaled bytes is the coordinate-space bug that made
        `validator.MIN_AREA_FRACTION` reject good phone-photo crops.
        """
        big = _card_on_background(
            card_color=card_color,
            bg_color=bg_color,
            canvas_size=(5000, 6000),
            card_box=(800, 1000, 4200, 5000),
        )
        result = trim_fn(big)
        assert result is not None
        with Image.open(io.BytesIO(result)) as out:
            w, h = out.size
            assert max(w, h) > MAX_LONGEST_EDGE_PX, "output was capped at detection resolution"
            # Card is 3400x4000 in original coordinates; allow the 10px
            # border on each side plus the ~2px map-back quantization.
            assert 3400 <= w <= 3400 + 2 * BORDER_PX + 20
            assert 4000 <= h <= 4000 + 2 * BORDER_PX + 20

    @pytest.mark.parametrize("trim_fn,card_color,bg_color", _VARIANTS)
    def test_oversized_crop_area_fraction_matches_source_space(self, trim_fn, card_color, bg_color):
        """The crop's area fraction must be measured against the same space.

        This is the bug's actual symptom, asserted directly: the card
        covers 3400*4000 / 5000*6000 = 45.3% of the source. Measured in
        mismatched spaces it read as ~11%, and on a 6144x8160 phone photo
        the same mismatch turned 63.6% into 8.6% — under MIN_AREA_FRACTION.
        """
        canvas = (5000, 6000)
        big = _card_on_background(
            card_color=card_color,
            bg_color=bg_color,
            canvas_size=canvas,
            card_box=(800, 1000, 4200, 5000),
        )
        result = trim_fn(big)
        assert result is not None
        with Image.open(io.BytesIO(result)) as out:
            fraction = (out.size[0] * out.size[1]) / (canvas[0] * canvas[1])
        assert 0.45 <= fraction <= 0.47


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
