"""Unit tests for app.edit, the hand-edit geometry and renderer (NEO-481).

The golden cases in `apps/web/lib/photo-edit/golden.json` are the contract
the web editor's geometry (vitest) and this renderer (pytest) both read, so a
drift on either side goes red on that side. Beyond the golden numbers, the
pixel tests here prove the renderer cuts what the geometry says: quarter
turns and right-angle boxes are exact pixel permutations, and a box at any
other angle samples the source where its corners say it does.
"""

from __future__ import annotations

import io
import json
import math
import random
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app import edit as photo_edit
from app.copy_photos import derive_copy_photos_from_image
from app.edit import (
    EditCrop,
    EditError,
    EditFrameMismatchError,
    EditOutOfFrameError,
    PhotoEdit,
    opening_turns,
    plan_edit,
    render_edit,
    round_half_up,
)

GOLDEN_PATH = Path(__file__).resolve().parents[4] / "apps/web/lib/photo-edit/golden.json"
GOLDEN = json.loads(GOLDEN_PATH.read_text())
CORNER_TOLERANCE = 1e-3


def _edit(raw: dict) -> PhotoEdit:
    crop = raw["crop"]
    return PhotoEdit(
        turns=raw["turns"],
        crop=None
        if crop is None
        else EditCrop(
            cx=crop["cx"],
            cy=crop["cy"],
            w=crop["w"],
            h=crop["h"],
            angle=crop["angle"],
            src_w=crop["srcW"],
            src_h=crop["srcH"],
        ),
    )


def _noise(size: tuple[int, int], seed: int = 481) -> Image.Image:
    rng = random.Random(seed)
    return Image.frombytes("RGB", size, rng.randbytes(size[0] * size[1] * 3))


def _size_of(data: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(data)) as img:
        return img.size


def _box(cx, cy, w, h, angle=0.0, src=(100, 80)) -> EditCrop:
    return EditCrop(cx=cx, cy=cy, w=w, h=h, angle=angle, src_w=src[0], src_h=src[1])


# ── The shared golden cases ─────────────────────────────────────────────────


class TestGolden:
    def test_the_fixture_has_cases(self):
        assert len(GOLDEN["cases"]) >= 8
        assert len(GOLDEN["openingTurns"]) >= 5

    @pytest.mark.parametrize("case", GOLDEN["cases"], ids=lambda c: c["name"])
    def test_corners_and_output_size(self, case):
        plan = plan_edit(_edit(case["edit"]), *case["src"])

        for got, want in zip(plan.corners, case["expect"]["corners"], strict=True):
            assert got == pytest.approx(tuple(want), abs=CORNER_TOLERANCE)
        assert [plan.out_w, plan.out_h] == case["expect"]["output"]

    @pytest.mark.parametrize("case", GOLDEN["cases"], ids=lambda c: c["name"])
    def test_rendered_sizes(self, case):
        """The real render and the real fitting land on the pinned sizes."""
        source = Image.new("RGB", tuple(case["src"]), (120, 130, 140))

        rendered = render_edit(source, _edit(case["edit"]))
        sizes = derive_copy_photos_from_image(rendered, icc_profile=None, dpi=None)

        assert list(rendered.size) == case["expect"]["output"]
        assert list(_size_of(sizes.image)) == case["expect"]["image"]
        assert list(_size_of(sizes.thumb)) == case["expect"]["thumb"]

    @pytest.mark.parametrize(
        "case", GOLDEN["openingTurns"], ids=lambda c: f"rotation={c['rotationDegrees']}"
    )
    def test_opening_turns(self, case):
        assert opening_turns(case["rotationDegrees"]) == case["turns"]


# ── Rounding ────────────────────────────────────────────────────────────────


class TestRounding:
    @pytest.mark.parametrize(
        ("value", "expected"),
        [(0.5, 1), (1.5, 2), (2.5, 3), (2.4999, 2), (-0.5, 0), (-1.5, -1), (1400.5, 1401)],
    )
    def test_half_rounds_up_never_to_even(self, value, expected):
        assert round_half_up(value) == expected

    def test_a_half_pixel_box_rounds_up(self):
        plan = plan_edit(PhotoEdit(0, _box(50, 40, 20.5, 30.5)), 100, 80)

        assert (plan.out_w, plan.out_h) == (21, 31)


# ── Exact paths ─────────────────────────────────────────────────────────────


class TestQuarterTurnsAreExact:
    @pytest.mark.parametrize(
        ("turns", "transpose"),
        [
            (1, Image.Transpose.ROTATE_270),
            (2, Image.Transpose.ROTATE_180),
            (3, Image.Transpose.ROTATE_90),
        ],
    )
    def test_a_turn_is_a_pixel_permutation(self, turns, transpose):
        source = _noise((37, 23))

        out = render_edit(source, PhotoEdit(turns, None))

        assert out.tobytes() == source.transpose(transpose).tobytes()

    def test_one_turn_is_clockwise(self):
        """The source's top-left pixel ends up at the output's top-right."""
        source = Image.new("RGB", (4, 2), (0, 0, 0))
        source.putpixel((0, 0), (255, 0, 0))

        out = render_edit(source, PhotoEdit(1, None))

        assert out.size == (2, 4)
        assert out.getpixel((1, 0)) == (255, 0, 0)

    def test_no_edit_returns_the_source_pixels(self):
        source = _noise((20, 30))

        assert render_edit(source, PhotoEdit(0, None)).tobytes() == source.tobytes()


class TestRightAngleBoxesAreExact:
    def test_an_upright_box_on_the_grid_is_a_plain_crop(self):
        source = _noise((100, 80))

        out = render_edit(source, PhotoEdit(0, _box(40, 30, 20, 30)))

        assert out.tobytes() == source.crop((30, 15, 50, 45)).tobytes()

    @pytest.mark.parametrize(
        ("angle", "transpose"),
        [
            (90, Image.Transpose.ROTATE_90),
            (180, Image.Transpose.ROTATE_180),
            (-90, Image.Transpose.ROTATE_270),
        ],
    )
    def test_a_turned_box_on_the_grid_is_a_crop_and_a_transpose(self, angle, transpose):
        source = _noise((100, 80))
        # A 20 x 30 box turned a quarter covers a 30 x 20 region.
        size = (20, 30) if angle != 180 else (30, 20)
        box = _box(50, 40, size[0], size[1], angle)
        region_w, region_h = (size[1], size[0]) if angle != 180 else size
        region = (50 - region_w // 2, 40 - region_h // 2, 50 + region_w // 2, 40 + region_h // 2)

        out = render_edit(source, PhotoEdit(0, box))

        assert out.size == size
        assert out.tobytes() == source.crop(region).transpose(transpose).tobytes()

    def test_a_box_at_90_puts_its_own_top_left_corner_at_the_output_top_left(self):
        """Angle 90: the box's top edge runs down the region's right side, so
        the pixel just inside the box's top-left corner leads the output."""
        source = _noise((100, 80))
        box = _box(50, 40, 20, 30, 90)
        top_left = plan_edit(PhotoEdit(0, box), 100, 80).corners[0]
        assert top_left == pytest.approx((65, 30))

        out = render_edit(source, PhotoEdit(0, box))

        assert out.getpixel((0, 0)) == source.getpixel((64, 30))

    def test_turns_follow_the_crop(self):
        source = _noise((100, 80))
        box = _box(40, 30, 20, 30)

        out = render_edit(source, PhotoEdit(1, box))

        cropped = source.crop((30, 15, 50, 45))
        assert out.tobytes() == cropped.transpose(Image.Transpose.ROTATE_270).tobytes()


# ── The resampled path ──────────────────────────────────────────────────────


def _gradient(size: tuple[int, int]) -> Image.Image:
    """R rises with x, G with y: a linear field bicubic reproduces exactly."""
    w, h = size
    xs = (np.arange(w) + 0.5) / w * 250
    ys = (np.arange(h) + 0.5) / h * 250
    arr = np.zeros((h, w, 3), np.float64)
    arr[..., 0] = xs[None, :]
    arr[..., 1] = ys[:, None]
    return Image.fromarray(np.round(arr).astype(np.uint8), "RGB")


class TestTiltedBoxes:
    @pytest.mark.parametrize("angle", [30.0, -7.25, 133.0, -170.0])
    def test_each_output_pixel_samples_where_the_box_says(self, angle):
        w, h = 400, 300
        source = _gradient((w, h))
        box = _box(200, 150, 80, 110, angle, src=(w, h))

        out = np.asarray(render_edit(source, PhotoEdit(0, box)), np.float64)

        rad = math.radians(angle)
        # Interior pixels only: the gradient is linear there, so bicubic is
        # exact up to the source's own 8-bit rounding.
        for v in range(10, out.shape[0] - 10, 13):
            for u in range(10, out.shape[1] - 10, 11):
                lx, ly = u + 0.5 - box.w / 2, v + 0.5 - box.h / 2
                sx = box.cx + lx * math.cos(rad) - ly * math.sin(rad)
                sy = box.cy + lx * math.sin(rad) + ly * math.cos(rad)
                assert out[v, u, 0] == pytest.approx(sx / w * 250, abs=1.5)
                assert out[v, u, 1] == pytest.approx(sy / h * 250, abs=1.5)

    def test_a_box_drawn_on_another_frame_scales_with_the_source(self):
        source = _gradient((400, 300))
        half = PhotoEdit(0, _box(100, 75, 40, 55, 20.0, src=(200, 150)))
        full = PhotoEdit(0, _box(200, 150, 80, 110, 20.0, src=(400, 300)))

        a = np.asarray(render_edit(source, half), np.int16)
        b = np.asarray(render_edit(source, full), np.int16)

        assert a.shape == b.shape == (110, 80, 3)
        assert np.abs(a - b).max() == 0


# ── Refusals ────────────────────────────────────────────────────────────────


class TestRefusals:
    def test_a_box_past_the_frame_is_refused(self):
        with pytest.raises(EditOutOfFrameError):
            plan_edit(PhotoEdit(0, _box(95, 40, 20, 20)), 100, 80)

    def test_a_tilted_box_whose_corner_leaves_the_frame_is_refused(self):
        # Upright it fits; at 45 degrees its corners reach past the top.
        with pytest.raises(EditOutOfFrameError):
            plan_edit(PhotoEdit(0, _box(50, 40, 70, 70, 45)), 100, 80)

    def test_a_half_pixel_of_float_noise_is_tolerated(self):
        plan = plan_edit(PhotoEdit(0, _box(50, 40, 100.4, 80.4)), 100, 80)

        assert (plan.crop_w, plan.crop_h) == (100, 80)

    def test_a_frame_of_another_shape_is_refused(self):
        with pytest.raises(EditFrameMismatchError):
            plan_edit(PhotoEdit(0, _box(50, 40, 10, 10, src=(100, 80))), 100, 100)

    def test_a_frame_of_the_same_shape_at_another_size_is_scaled(self):
        plan = plan_edit(PhotoEdit(0, _box(50, 40, 10, 20, src=(100, 80))), 300, 240)

        assert (plan.crop_w, plan.crop_h) == (30, 60)

    @pytest.mark.parametrize(
        "box",
        [
            _box(50, 40, 0, 10),
            _box(50, 40, 10, -1),
            _box(50, 40, 10, 10, angle=-180),
            _box(50, 40, 10, 10, angle=180.5),
            _box(float("nan"), 40, 10, 10),
            _box(50, 40, float("inf"), 10),
        ],
    )
    def test_malformed_boxes_are_refused(self, box):
        with pytest.raises(EditError):
            plan_edit(PhotoEdit(0, box), 100, 80)

    def test_angle_180_is_allowed(self):
        plan_edit(PhotoEdit(0, _box(50, 40, 10, 10, angle=180)), 100, 80)

    @pytest.mark.parametrize("turns", [-1, 4])
    def test_turns_outside_a_quarter_set_are_refused(self, turns):
        with pytest.raises(EditError):
            plan_edit(PhotoEdit(turns, None), 100, 80)

    def test_error_codes(self):
        assert EditError.code == "INVALID_EDIT"
        assert EditFrameMismatchError.code == "EDIT_FRAME_MISMATCH"
        assert EditOutOfFrameError.code == "EDIT_OUT_OF_FRAME"
        assert photo_edit.FRAME_TOLERANCE_PX == 0.5
