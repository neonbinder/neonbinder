"""Unit tests for app.exif — EXIF orientation normalisation.

Covers: reading the orientation tag (present, absent, malformed, unreadable
bytes), the no-op fast path returning the *same bytes object* rather than a
re-encode, the actual pixel transpose for every rotating orientation value,
the tag being stripped afterwards so a second pass is a no-op, and format
handling (JPEG/PNG round-trip, alpha flattened when falling back to JPEG).

Images are synthesized in-test with PIL; no fixtures, no network.
"""

from __future__ import annotations

from io import BytesIO

import pytest
from PIL import Image

from app.exif import (
    EXIF_ORIENTATION_AS_STORED,
    EXIF_ORIENTATION_TAG,
    EXIF_ORIENTATION_VALUES,
    apply_exif_orientation,
    read_exif_orientation,
)

# Orientation values whose transpose swaps width and height (the four that
# involve a 90-degree turn). 2/3/4 are flips and mirror in place.
TRANSPOSING_ORIENTATIONS = (5, 6, 7, 8)
IN_PLACE_ORIENTATIONS = (1, 2, 3, 4)


def _asymmetric_image(size: tuple[int, int] = (60, 40)) -> Image.Image:
    """A landscape image with a distinguishable corner, so a flip is visible."""
    img = Image.new("RGB", size, (10, 20, 30))
    for x in range(size[0] // 3):
        for y in range(size[1] // 3):
            img.putpixel((x, y), (250, 5, 5))
    return img


def _jpeg(orientation: int | None = None, size: tuple[int, int] = (60, 40)) -> bytes:
    img = _asymmetric_image(size)
    out = BytesIO()
    if orientation is None:
        img.save(out, format="JPEG", quality=95)
    else:
        exif = img.getexif()
        exif[EXIF_ORIENTATION_TAG] = orientation
        img.save(out, format="JPEG", quality=95, exif=exif)
    return out.getvalue()


def _png(orientation: int | None = None) -> bytes:
    img = _asymmetric_image()
    out = BytesIO()
    if orientation is None:
        img.save(out, format="PNG")
    else:
        exif = img.getexif()
        exif[EXIF_ORIENTATION_TAG] = orientation
        img.save(out, format="PNG", exif=exif)
    return out.getvalue()


def _size_of(image_bytes: bytes) -> tuple[int, int]:
    with Image.open(BytesIO(image_bytes)) as img:
        return img.size


def _format_of(image_bytes: bytes) -> str:
    with Image.open(BytesIO(image_bytes)) as img:
        return img.format or ""


class TestReadExifOrientation:
    @pytest.mark.parametrize("orientation", sorted(EXIF_ORIENTATION_VALUES))
    def test_reads_every_valid_value(self, orientation):
        assert read_exif_orientation(_jpeg(orientation)) == orientation

    def test_missing_tag_reads_as_stored(self):
        assert read_exif_orientation(_jpeg()) == EXIF_ORIENTATION_AS_STORED

    @pytest.mark.parametrize("bogus", [0, 9, 255, 65535])
    def test_out_of_range_value_reads_as_stored(self, bogus):
        assert read_exif_orientation(_jpeg(bogus)) == EXIF_ORIENTATION_AS_STORED

    def test_undecodable_bytes_read_as_stored(self):
        assert read_exif_orientation(b"not an image at all") == EXIF_ORIENTATION_AS_STORED

    def test_empty_bytes_read_as_stored(self):
        assert read_exif_orientation(b"") == EXIF_ORIENTATION_AS_STORED


class TestApplyExifOrientation:
    def test_as_stored_returns_the_same_object(self):
        # Identity, not equality: the fast path must not decode/re-encode, so
        # the overwhelmingly common case costs nothing and loses no quality.
        original = _jpeg()
        result, orientation = apply_exif_orientation(original)
        assert result is original
        assert orientation == EXIF_ORIENTATION_AS_STORED

    def test_undecodable_bytes_pass_through_untouched(self):
        junk = b"still not an image"
        result, orientation = apply_exif_orientation(junk)
        assert result is junk
        assert orientation == EXIF_ORIENTATION_AS_STORED

    @pytest.mark.parametrize("orientation", TRANSPOSING_ORIENTATIONS)
    def test_rotating_orientations_swap_dimensions(self, orientation):
        result, reported = apply_exif_orientation(_jpeg(orientation, size=(60, 40)))
        assert reported == orientation
        assert _size_of(result) == (40, 60)

    @pytest.mark.parametrize("orientation", IN_PLACE_ORIENTATIONS[1:])
    def test_mirroring_orientations_keep_dimensions_but_move_pixels(self, orientation):
        source = _jpeg(orientation, size=(60, 40))
        result, reported = apply_exif_orientation(source)
        assert reported == orientation
        assert _size_of(result) == (60, 40)
        assert result != source

    @pytest.mark.parametrize("orientation", sorted(EXIF_ORIENTATION_VALUES - {1}))
    def test_second_pass_is_a_no_op(self, orientation):
        once, _ = apply_exif_orientation(_jpeg(orientation))
        twice, reported = apply_exif_orientation(once)
        # exif_transpose drops the tag, so a re-run must not rotate again.
        assert reported == EXIF_ORIENTATION_AS_STORED
        assert twice is once

    def test_jpeg_stays_jpeg(self):
        result, _ = apply_exif_orientation(_jpeg(6))
        assert _format_of(result) == "JPEG"

    def test_png_stays_png(self):
        result, _ = apply_exif_orientation(_png(6))
        assert _format_of(result) == "PNG"
        assert _size_of(result) == (40, 60)

    def test_unsupported_format_falls_back_to_jpeg(self):
        img = _asymmetric_image().convert("RGBA")
        exif = img.getexif()
        exif[EXIF_ORIENTATION_TAG] = 6
        out = BytesIO()
        # TIFF is readable by PIL but not in the round-trip allow-list, and
        # RGBA additionally cannot be stored in a JPEG without flattening.
        img.save(out, format="TIFF", exif=exif)

        result, reported = apply_exif_orientation(out.getvalue())

        assert reported == 6
        assert _format_of(result) == "JPEG"
        assert _size_of(result) == (40, 60)
