"""Unit tests for app.imaging — the ceiling measured in pixels, not bytes.

Covers: the process-wide Pillow ceiling being lowered on import (and applied by
importing `app.main`), header-only dimension reads, the rejection of a real
decompression bomb decoded from real bytes, the deliberate tolerance of
unreadable headers, and the boundary itself — that the cap admits the largest
image a consumer camera actually produces while refusing the bomb.

The bomb here is synthesized and genuinely decoded, not asserted about by byte
count: the whole finding was that byte count is the wrong unit.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image

from app.imaging import (
    MAX_IMAGE_PIXELS,
    RasterTooLargeError,
    check_raster_size,
    read_raster_size,
)

# The bomb from the security finding: flat colour, so it compresses to almost
# nothing, and 169 MP so it decodes to ~484 MB.
BOMB_EDGE_PX = 13_000

# 8064x6048 is an iPhone in 48 MP mode — the largest raster a phone in a user's
# pocket produces today, and therefore the thing the cap must NOT reject.
IPHONE_48MP = (8064, 6048)


def png_of(size: tuple[int, int]) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, (255, 255, 255)).save(out, format="PNG", compress_level=9)
    return out.getvalue()


def jpeg_of(size: tuple[int, int]) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, (200, 30, 30)).save(out, format="JPEG", quality=60)
    return out.getvalue()


@pytest.fixture(scope="module")
def bomb_png() -> bytes:
    """A real 169 MP PNG. Built once — it is slow to encode, not to store."""
    return png_of((BOMB_EDGE_PX, BOMB_EDGE_PX))


class TestProcessWideCeiling:
    def test_importing_the_module_lowers_pillows_ceiling(self):
        # The only protection for decode paths that never call this module —
        # pil_trim, sam, validator and classify all open images themselves.
        assert Image.MAX_IMAGE_PIXELS == MAX_IMAGE_PIXELS

    def test_importing_the_service_entrypoint_applies_it(self):
        import importlib

        importlib.import_module("app.main")
        assert Image.MAX_IMAGE_PIXELS == MAX_IMAGE_PIXELS

    def test_the_ceiling_is_well_below_pillows_default(self):
        # Pillow's stock ceiling only *warns* below 178,956,970 px, which is
        # why the bomb sits at 169 MP — deliberately underneath it.
        assert MAX_IMAGE_PIXELS < 89_478_485


class TestTheBoundary:
    def test_admits_the_largest_consumer_camera_raster(self):
        # Rejecting a 48 MP phone photo would be a product bug: a zip of phone
        # photos is exactly the input this feature exists for.
        width, height = IPHONE_48MP
        assert width * height <= MAX_IMAGE_PIXELS

    def test_refuses_the_bomb_by_a_wide_margin(self):
        assert BOMB_EDGE_PX * BOMB_EDGE_PX > 3 * MAX_IMAGE_PIXELS

    def test_a_decoded_raster_at_the_cap_fits_the_instance(self):
        # 3 bytes per pixel, and the cascade holds several copies at once on a
        # 4 GiB instance that is also holding SAM.
        assert MAX_IMAGE_PIXELS * 3 < 200 * 1024 * 1024


class TestReadRasterSize:
    def test_reads_dimensions_from_the_header(self):
        assert read_raster_size(jpeg_of((640, 480))) == (640, 480)

    @pytest.mark.parametrize("payload", [b"", b"not an image", b"\xff\xd8truncated"])
    def test_unreadable_headers_are_none_not_an_error(self, payload):
        # Deliberately not an error: callers already diagnose undecodable bytes
        # their own way, and "too big" would be a worse answer than theirs.
        assert read_raster_size(payload) is None

    def test_a_bomb_past_pillows_hard_limit_raises_rather_than_reading_as_junk(self, bomb_png):
        # Above 2x the ceiling Pillow refuses to report a size at all. Letting
        # that surface as "unreadable" would file a bomb as a corrupt file.
        with pytest.raises(RasterTooLargeError):
            read_raster_size(bomb_png)


class TestCheckRasterSize:
    def test_passes_an_ordinary_card_photo(self):
        assert check_raster_size(jpeg_of((1200, 1680))) == (1200, 1680)

    def test_rejects_the_bomb(self, bomb_png):
        # The point of the finding, asserted end to end on real bytes: this
        # file is half a megabyte and would decode to 484 MB.
        assert len(bomb_png) < 1024 * 1024
        with pytest.raises(RasterTooLargeError):
            check_raster_size(bomb_png)

    def test_rejects_a_bomb_that_sits_under_pillows_own_warning(self):
        # Between MAX_IMAGE_PIXELS and 2x it, Pillow only warns — so this is
        # the band that exists solely because of the explicit check.
        edge = 8_000  # 64 MP: over our cap, under Pillow's raise threshold
        assert MAX_IMAGE_PIXELS < edge * edge <= 2 * MAX_IMAGE_PIXELS
        with pytest.raises(RasterTooLargeError):
            check_raster_size(png_of((edge, edge)))

    def test_unreadable_header_is_tolerated(self):
        assert check_raster_size(b"definitely not an image") is None

    def test_error_names_the_actual_dimensions(self):
        with pytest.raises(RasterTooLargeError, match="8000x8000"):
            check_raster_size(png_of((8_000, 8_000)))
