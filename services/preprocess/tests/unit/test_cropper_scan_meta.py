"""Unit tests for the NEO-191 scanner-metadata identity pre-check.

`scan_meta.is_card_sized_scan` answers one question — "does this frame
physically measure one trading card?" — from the resolution the producing
device recorded, and returns None for everything else. None means "no
information, let the pixel cascade decide", so every rejection path below is
asserting a *fail-safe*, not a feature.

The two directions that matter, and why:

  - A true accept must be tight enough that a card plus real margin cannot fit
    inside it. Anything looser and the check starts approving frames that
    genuinely need cropping, which is the one failure mode with no recovery —
    the shaved border is gone.
  - A reject must be reachable from ordinary inputs. 72-dpi camera stamps, JFIF
    aspect-ratio flags and stripped metadata are all common, and each has to
    land on None rather than on a bogus physical size.

Images are built with an explicit `dpi=` save argument, which is exactly how a
scanner writes the JFIF density field the check reads back.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image

from app.cropper import scan_meta
from app.cropper.scan_meta import ScanSize, is_card_sized_scan, measure

# A 400dpi scan of a standard card, the shape the Fujitsu fi-7160 emits.
SCANNER_DPI = 400
CARD_PX = (992, 1384)  # 2.48in x 3.46in at 400dpi


def _jpeg(
    size: tuple[int, int] = CARD_PX,
    *,
    dpi: tuple[int, int] | None = (SCANNER_DPI, SCANNER_DPI),
    fmt: str = "JPEG",
) -> bytes:
    """Encode a solid image, optionally stamping a JFIF/EXIF resolution."""
    img = Image.new("RGB", size, (200, 190, 180))
    out = io.BytesIO()
    save_kwargs = {"dpi": dpi} if dpi is not None else {}
    img.save(out, format=fmt, **save_kwargs)
    return out.getvalue()


class TestAccepts:
    """The frame measures one card, so there is no background to crop."""

    def test_a_400dpi_card_sized_scan_is_identified(self):
        size = is_card_sized_scan(_jpeg())

        assert size is not None
        assert size.dpi == pytest.approx(400)
        assert size.width_in == pytest.approx(2.48, abs=0.01)
        assert size.height_in == pytest.approx(3.46, abs=0.01)

    def test_landscape_scans_are_accepted_on_the_same_window(self):
        """Orientation is not the question — the check sorts the sides."""
        assert is_card_sized_scan(_jpeg(size=(CARD_PX[1], CARD_PX[0]))) is not None

    @pytest.mark.parametrize("dpi", [200, 300, 600, 1200])
    def test_any_plausible_scanner_resolution_works(self, dpi):
        px = (round(2.5 * dpi), round(3.5 * dpi))
        assert is_card_sized_scan(_jpeg(size=px, dpi=(dpi, dpi))) is not None

    def test_png_scans_are_read_too(self):
        assert is_card_sized_scan(_jpeg(fmt="PNG")) is not None

    def test_the_real_corpus_undersize_extreme_still_accepts(self):
        """The smallest true positive measured across the 574-image intake
        batch: 2.450 x 3.450in, 2.0% under nominal on both sides. The window
        has to clear this or the check misses real scans."""
        px = (round(2.450 * SCANNER_DPI), round(3.450 * SCANNER_DPI))
        assert is_card_sized_scan(_jpeg(size=px)) is not None


class TestRejectsOnSize:
    """Right metadata, wrong physical size — the cascade owns these."""

    def test_a_multi_card_bed_scan_is_rejected(self):
        """8.85 x 4.80in, the 27 flatbed strips in the intake batch. These
        genuinely need cropping and must reach the full pipeline."""
        px = (round(8.85 * SCANNER_DPI), round(4.80 * SCANNER_DPI))
        assert is_card_sized_scan(_jpeg(size=px)) is None

    def test_a_card_with_a_real_margin_is_rejected(self):
        """The load-bearing case: a card photographed or scanned with visible
        background around it measures LARGER than a card, which is precisely
        why a card-sized frame can be trusted to contain no background."""
        px = (round(3.2 * SCANNER_DPI), round(4.4 * SCANNER_DPI))
        assert is_card_sized_scan(_jpeg(size=px)) is None

    def test_a_graded_slab_is_rejected(self):
        """~3.25 x 5.25in. Slabs need the cascade's real crop."""
        px = (round(3.25 * SCANNER_DPI), round(5.25 * SCANNER_DPI))
        assert is_card_sized_scan(_jpeg(size=px)) is None

    def test_a_tallboy_is_rejected(self):
        """2.5 x 4.75in — correct short side, 36% long. One matching dimension
        must not be enough, or every tall format reads as a card."""
        px = (round(2.5 * SCANNER_DPI), round(4.75 * SCANNER_DPI))
        assert is_card_sized_scan(_jpeg(size=px)) is None

    def test_an_already_shaved_crop_is_rejected(self):
        """A border-shaved crop measures ~7% under on both sides. Outside the
        window, so a re-run of a bad crop is not blessed as pre-cropped."""
        px = (round(2.32 * SCANNER_DPI), round(3.25 * SCANNER_DPI))
        assert is_card_sized_scan(_jpeg(size=px)) is None

    @pytest.mark.parametrize("scale", [1 - 0.031, 1 + 0.031])
    def test_just_outside_the_tolerance_is_rejected(self, scale):
        px = (round(2.5 * scale * SCANNER_DPI), round(3.5 * scale * SCANNER_DPI))
        assert is_card_sized_scan(_jpeg(size=px)) is None


class TestRejectsOnProvenance:
    """The size might be right, but the metadata cannot be believed."""

    def test_a_72dpi_camera_stamp_is_rejected(self):
        """Every one of the 338 phone photos in `main/samples/` is 72dpi. The
        density is an editor default, not a measurement — so even a frame whose
        arithmetic lands on 2.5 x 3.5in must not be trusted."""
        px = (round(2.5 * 72), round(3.5 * 72))
        assert is_card_sized_scan(_jpeg(size=px, dpi=(72, 72))) is None

    def test_missing_resolution_is_rejected(self):
        assert is_card_sized_scan(_jpeg(dpi=None)) is None

    def test_a_jfif_aspect_ratio_flag_is_not_a_resolution(self):
        """JFIF density unit 0 means "these numbers are a pixel aspect ratio",
        with no physical unit attached.

        Pillow 12 already declines to populate `dpi` in that case, so this
        asserts the outcome, not the mechanism — see the companion test below
        for the guard itself, which exists because that has not always been
        Pillow's behaviour.
        """
        img = Image.new("RGB", CARD_PX, (200, 190, 180))
        out = io.BytesIO()
        img.save(out, format="JPEG", dpi=(SCANNER_DPI, SCANNER_DPI))
        raw = bytearray(out.getvalue())
        # APP0 JFIF: SOI(2) + marker(2) + length(2) + "JFIF\0"(5) + version(2),
        # then the density unit byte.
        assert raw[6:11] == b"JFIF\x00"
        raw[13] = 0  # units = no absolute size
        assert is_card_sized_scan(bytes(raw)) is None

    def test_the_unit_zero_guard_rejects_a_density_that_reaches_it(self):
        """Directly exercise `_trustworthy_dpi`'s unit-0 branch with an image
        that reports BOTH a unit-0 density and a dpi — the shape a Pillow that
        forwards the aspect-ratio pair would hand us. Without the guard this
        1:1 flag would be read as a physical resolution."""
        img = Image.new("RGB", CARD_PX)
        img.info["jfif_unit"] = 0
        img.info["dpi"] = (SCANNER_DPI, SCANNER_DPI)

        assert scan_meta._trustworthy_dpi(img) is None

    def test_anisotropic_resolution_is_rejected(self):
        """Real scanners are square. A wide x/y mismatch means the density
        fields are carrying something other than a physical resolution."""
        assert is_card_sized_scan(_jpeg(dpi=(400, 300))) is None

    @pytest.mark.parametrize("dpi", [(0, 0), (-400, -400)])
    def test_nonpositive_resolution_is_rejected(self, dpi):
        assert is_card_sized_scan(_jpeg(dpi=dpi)) is None

    def test_undecodable_bytes_are_rejected_without_raising(self):
        """A crop must never fail because metadata could not be parsed."""
        assert is_card_sized_scan(b"not an image at all") is None
        assert measure(b"") is None


class TestMeasure:
    """`measure` is the raw reading; `is_card_sized_scan` adds the verdict."""

    def test_measure_reports_physical_size(self):
        size = measure(_jpeg())

        assert isinstance(size, ScanSize)
        assert size.width_in == pytest.approx(992 / 400)
        assert size.height_in == pytest.approx(1384 / 400)

    def test_measure_reports_sizes_the_card_window_rejects(self):
        """Reading the size and judging it are separate: a bed scan measures
        fine, it just isn't a card."""
        px = (round(8.85 * SCANNER_DPI), round(4.80 * SCANNER_DPI))
        size = measure(_jpeg(size=px))

        assert size is not None
        assert size.width_in == pytest.approx(8.85, abs=0.01)

    def test_str_is_log_friendly(self):
        assert str(measure(_jpeg())) == "2.48x3.46in @400dpi"


class TestConstants:
    """These bounds are calibrated against a measured corpus, not taste."""

    def test_tolerance_spans_the_gap_between_the_populations(self):
        """Worst true positive is 2.0% off; nearest true negative is 153% off.
        The threshold must sit above the former and far below the latter."""
        assert 0.020 < scan_meta.SIZE_TOLERANCE < 0.10

    def test_the_dpi_floor_excludes_camera_defaults_and_admits_scanners(self):
        assert 72 < scan_meta.MIN_SCANNER_DPI <= 200
