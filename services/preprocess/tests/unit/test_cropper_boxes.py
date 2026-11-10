"""Unit tests for app.cropper.boxes and the `crop_box` each stage reports (NEO-481).

The box a stage reports must be the crop it cut: rendering that box with the
editor's renderer (`app.edit`) has to give back the stage's own pixels, or the
photo editor would open on a crop that is not the one the collector sees, and
saving it untouched would change their photo. So the stage tests below render
each reported box and compare it with what the stage returned.
"""

from __future__ import annotations

import io
import math

import cv2
import numpy as np
import pytest
from PIL import Image

from app import cropper
from app.classify import ClassifyResult
from app.cropper import boxes, frame_content, haiku_bbox, pil_trim, quad, sam, tiered
from app.cropper.boxes import CropBox
from app.edit import EditCrop, PhotoEdit, opening_turns, render_edit
from app.orient import OrientationResult
from tests.unit.test_cropper_quad import _canvas, _card_face, _jpeg, _place, _rect_corners


def _render_box(source_bgr: np.ndarray, box: CropBox) -> np.ndarray:
    """The box rendered by the editor's renderer, as BGR."""
    image = Image.fromarray(cv2.cvtColor(source_bgr, cv2.COLOR_BGR2RGB))
    crop = EditCrop(box.cx, box.cy, box.w, box.h, box.angle, box.src_w, box.src_h)
    rendered = render_edit(image, PhotoEdit(0, crop))
    return cv2.cvtColor(np.asarray(rendered), cv2.COLOR_RGB2BGR)


def _decode(data: bytes) -> np.ndarray:
    return cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)


def _mean_diff(a: np.ndarray, b: np.ndarray) -> float:
    """Mean absolute difference after resizing `b` onto `a` (sizes can differ by
    a pixel of rounding, and a perspective warp by its snapped aspect)."""
    b = cv2.resize(b, (a.shape[1], a.shape[0]), interpolation=cv2.INTER_AREA)
    return float(np.abs(a.astype(np.float32) - b.astype(np.float32)).mean())


def _record(fn, *args, **kwargs):
    with boxes.recording() as rec:
        result = fn(*args, **kwargs)
    return result, rec.box


# ── The helpers ─────────────────────────────────────────────────────────────


class TestHelpers:
    @pytest.mark.parametrize(
        ("value", "expected"),
        [(0, 0), (180, 180), (-180, 180), (190, -170), (-190, 170), (540, 180), (360, 0)],
    )
    def test_normalize_angle(self, value, expected):
        assert boxes.normalize_angle(value) == pytest.approx(expected)

    def test_full_frame(self):
        assert boxes.full_frame(40, 30) == CropBox(20, 15, 40, 30, 0, 40, 30)

    def test_axis_rect(self):
        assert boxes.from_axis_rect(10, 20, 30, 60, 100, 80) == CropBox(20, 40, 20, 40, 0, 100, 80)
        assert boxes.from_axis_rect(10, 20, 10, 60, 100, 80) is None

    def test_quad_of_an_upright_rectangle(self):
        q = np.array([[10, 20], [30, 20], [30, 60], [10, 60]], float)

        box = boxes.from_quad(q, 100, 80)

        assert (box.cx, box.cy, box.w, box.h, box.angle) == pytest.approx((20, 40, 20, 40, 0))

    def test_quad_of_a_tilted_rectangle_reads_its_top_edge_angle(self):
        q = _rect_corners(50, 40, 20, 30, 12)

        box = boxes.from_quad(q, 100, 80)

        assert (box.cx, box.cy, box.w, box.h, box.angle) == pytest.approx((50, 40, 20, 30, 12))

    def test_a_quarter_turn_ccw_swaps_the_sides_and_turns_the_top(self):
        turned = boxes.turned_ccw(CropBox(50, 40, 30, 20, 10, 100, 80))

        assert (turned.w, turned.h, turned.angle) == (20, 30, 100)

    def test_rotated_rect_without_area_is_none(self):
        assert boxes.from_rotated_rect(5, 5, 0, 4, 0, 10, 10) is None

    def test_record_outside_recording_is_a_no_op(self):
        boxes.record(boxes.full_frame(4, 4))  # must not raise

    def test_recordings_do_not_leak_between_blocks(self):
        with boxes.recording() as first:
            boxes.record(boxes.full_frame(4, 4))
        with boxes.recording() as second:
            pass
        assert first.box is not None
        assert second.box is None


class TestFitInside:
    def test_a_box_inside_is_unchanged(self):
        box = CropBox(50, 40, 20, 20, 15, 100, 80)
        assert boxes.fit_inside(box) is box

    def test_the_whole_frame_stays_the_whole_frame(self):
        box = boxes.full_frame(4000, 3000)
        assert boxes.fit_inside(box) == box

    def test_a_padded_box_overhanging_the_frame_shrinks_about_its_centre(self):
        box = CropBox(50, 40, 102, 60, 0, 100, 80)

        fitted = boxes.fit_inside(box)

        assert (fitted.cx, fitted.cy) == (50, 40)
        assert fitted.w == pytest.approx(100)
        assert fitted.h == pytest.approx(60 * 100 / 102)
        _assert_inside(fitted)

    def test_a_tilted_overhang_fits_inside(self):
        fitted = boxes.fit_inside(CropBox(50, 40, 70, 70, 10, 100, 80))
        # 70 x 70 at 10 degrees spans ~81 px, past the 80 px height.
        assert fitted is not None and fitted.w < 70
        _assert_inside(fitted)

    def test_a_box_far_outside_is_dropped(self):
        assert boxes.fit_inside(CropBox(50, 40, 200, 160, 0, 100, 80)) is None

    def test_a_centre_outside_the_frame_is_dropped(self):
        assert boxes.fit_inside(CropBox(-5, 40, 10, 10, 0, 100, 80)) is None

    def test_none_and_nonsense_are_dropped(self):
        assert boxes.fit_inside(None) is None
        assert boxes.fit_inside(CropBox(math.nan, 40, 10, 10, 0, 100, 80)) is None
        assert boxes.fit_inside(CropBox(50, 40, 0, 10, 0, 100, 80)) is None


def _assert_inside(box: CropBox) -> None:
    rad = math.radians(box.angle)
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        x = box.cx + sx * box.w / 2 * math.cos(rad) - sy * box.h / 2 * math.sin(rad)
        y = box.cy + sx * box.w / 2 * math.sin(rad) + sy * box.h / 2 * math.cos(rad)
        assert -1e-6 <= x <= box.src_w + 1e-6
        assert -1e-6 <= y <= box.src_h + 1e-6


# ── Each stage's box renders its own crop ───────────────────────────────────


@pytest.fixture()
def _no_birefnet(monkeypatch):
    def _boom(*_args, **_kwargs):
        raise AssertionError("no model in these tests")

    monkeypatch.setattr(tiered, "birefnet_mask", _boom)
    monkeypatch.setattr(tiered, "_get_session", _boom)


@pytest.mark.usefixtures("_no_birefnet")
class TestQuadBox:
    @pytest.mark.parametrize("angle", [8.0, -5.0, 0.0])
    def test_the_box_renders_the_quad_crop(self, angle):
        scene = _place(
            _canvas((1200, 1600)), _card_face(), _rect_corners(600, 800, 500, 700, angle)
        )

        result, box = _record(quad.quad_crop, _jpeg(scene))

        assert result.accepted, result.diagnostics
        assert box is not None
        assert box.angle == pytest.approx(angle, abs=1.0)
        assert _mean_diff(_decode(result.crop_bytes), _render_box(_decode(_jpeg(scene)), box)) < 6

    def test_a_landscape_card_turned_portrait_reports_the_turned_box(self):
        face = cv2.rotate(_card_face(), cv2.ROTATE_90_CLOCKWISE)
        scene = _place(_canvas((1600, 1200)), face, _rect_corners(800, 600, 700, 500, 3))

        result, box = _record(quad.quad_crop, _jpeg(scene))

        assert result.accepted, result.diagnostics
        assert box.h > box.w, "the box describes the portrait crop"
        assert _mean_diff(_decode(result.crop_bytes), _render_box(_decode(_jpeg(scene)), box)) < 6

    def test_a_declined_scene_reports_no_box(self):
        _result, box = _record(quad.quad_crop, _jpeg(_canvas((800, 600))))

        assert box is None


class TestTieredBox:
    def _scene(self, angle: float) -> np.ndarray:
        return _place(_canvas((1200, 1600)), _card_face(), _rect_corners(600, 800, 500, 700, angle))

    def test_the_quad_route_box_renders_its_crop(self):
        full = self._scene(6.0)
        comp = {"route": "quad", "quad": _rect_corners(600, 800, 500, 700, 6.0)}

        crop, box = _record(tiered.final_crop, full, 1.0, comp, 4.0)

        assert 500 < box.w < 510, "the padded quad, a little past the card"
        assert _mean_diff(crop, _render_box(full, box)) < 6

    def test_the_rect_route_box_renders_its_crop(self):
        full = self._scene(-9.0)
        rect = cv2.minAreaRect(_rect_corners(600, 800, 500, 700, -9.0).astype(np.float32))

        crop, box = _record(tiered.final_crop, full, 1.0, {"route": "rect", "rect": rect}, 3.0)

        assert crop.shape[0] > crop.shape[1]
        assert _mean_diff(crop, _render_box(full, box)) < 6

    def test_a_work_scale_detection_reports_full_resolution_pixels(self):
        full = self._scene(4.0)
        comp = {"route": "quad", "quad": _rect_corners(600, 800, 500, 700, 4.0) * 0.5}

        crop, box = _record(tiered.final_crop, full, 0.5, comp, 2.0)

        assert (box.src_w, box.src_h) == (1200, 1600)
        assert box.cx == pytest.approx(600, abs=1)
        assert _mean_diff(crop, _render_box(full, box)) < 6


class TestSamBox:
    @pytest.mark.parametrize("angle", [0.2, 11.0, -14.0])
    def test_the_box_renders_its_crop(self, angle):
        full = _place(_canvas((1200, 1600)), _card_face(), _rect_corners(600, 800, 500, 700, angle))
        pts = _rect_corners(600, 800, 500, 700, angle).astype(np.float32)

        (crop, _pts), box = _record(sam._rotate_and_crop, full, pts, padding=0)

        assert _mean_diff(crop, _render_box(full, box)) < 8


class TestPilTrimBox:
    def test_the_box_is_the_trimmed_region_without_the_border(self):
        img = Image.new("RGB", (400, 500), (10, 10, 10))
        img.paste(Image.new("RGB", (200, 280), (230, 230, 230)), (100, 120))
        buf = io.BytesIO()
        img.save(buf, format="PNG")

        out, box = _record(pil_trim.trim_dark, buf.getvalue())

        assert out is not None
        assert box is not None and box.angle == 0
        assert (box.src_w, box.src_h) == (400, 500)
        assert box.cx == pytest.approx(200, abs=3)
        assert box.cy == pytest.approx(260, abs=3)
        assert box.w == pytest.approx(200, abs=6)
        assert box.h == pytest.approx(280, abs=6)


class TestHaikuBox:
    def test_the_box_is_the_rescaled_bbox(self, monkeypatch):
        img = Image.new("RGB", (400, 500), "white")
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        monkeypatch.setattr(
            haiku_bbox, "_call_haiku", lambda *_a, **_k: '{"x": 40, "y": 50, "w": 100, "h": 140}'
        )

        out, box = _record(haiku_bbox.haiku_bbox_crop, buf.getvalue(), client=object())

        assert out is not None
        assert box == boxes.from_axis_rect(40, 50, 140, 190, 400, 500)


# ── The cascade carries the winner's box ────────────────────────────────────


def _stub_gates(monkeypatch, rotation: int = 0) -> None:
    monkeypatch.setattr(
        cropper,
        "detect_orientation",
        lambda _b: OrientationResult(rotation_degrees=rotation, confidence=1.0, text_count=50),
    )
    monkeypatch.setattr(
        cropper,
        "classify_card",
        lambda _b: ClassifyResult(players=[], team=None, card_number=None, side=None, raw_text=""),
    )


def _png(size: tuple[int, int]) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (90, 90, 90)).save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.usefixtures("_no_birefnet")
class TestCascadeCarriesTheBox:
    def test_a_quad_win_carries_its_box_and_the_box_reproduces_the_output(self, monkeypatch):
        """The editor opens on crop_box with turns from rotation_degrees; that
        must render the output /process-entry stores, so an untouched save
        changes nothing."""
        _stub_gates(monkeypatch, rotation=90)
        monkeypatch.setattr(cropper.scan_meta, "is_card_sized_scan", lambda _b: None)
        monkeypatch.setattr(tiered, "fast_tiered_verdict", lambda _b: (None, "crop"))
        scene = _place(_canvas((1200, 1600)), _card_face(), _rect_corners(600, 800, 500, 700, 7))
        image = _jpeg(scene)

        result = cropper.crop(image_bytes=image, precropped_bytes=None, escalate_only=True)

        assert result.source == "quad"
        assert result.crop_box is not None
        stored = _decode(result.rotated_bytes)
        source = Image.open(io.BytesIO(image)).convert("RGB")
        box = result.crop_box
        crop = EditCrop(box.cx, box.cy, box.w, box.h, box.angle, box.src_w, box.src_h)
        reopened = render_edit(source, PhotoEdit(opening_turns(90), crop))
        reopened_bgr = cv2.cvtColor(np.asarray(reopened), cv2.COLOR_RGB2BGR)
        assert reopened_bgr.shape[0] < reopened_bgr.shape[1], "turned like the output"
        assert _mean_diff(stored, reopened_bgr) < 6

    def test_a_scan_metadata_identity_carries_the_whole_frame(self, monkeypatch):
        _stub_gates(monkeypatch)
        monkeypatch.setattr(cropper.scan_meta, "is_card_sized_scan", lambda _b: object())
        monkeypatch.setattr(cropper, "is_plausible_crop", _ok_validator)

        result = cropper.crop(image_bytes=_png((250, 350)), precropped_bytes=None)

        assert result.source == "scan_metadata"
        assert result.crop_box == boxes.full_frame(250, 350)

    def test_a_classical_identity_carries_the_whole_frame(self, monkeypatch):
        _stub_gates(monkeypatch)
        monkeypatch.setattr(cropper.scan_meta, "is_card_sized_scan", lambda _b: None)
        monkeypatch.setattr(tiered, "fast_tiered_verdict", lambda b: (b, "frame"))
        monkeypatch.setattr(cropper, "is_plausible_crop", _ok_validator)

        result = cropper.crop(image_bytes=_png((250, 350)), precropped_bytes=None)

        assert result.source == "tiered"
        assert result.crop_box == boxes.full_frame(250, 350)

    def test_a_frame_content_identity_carries_the_whole_frame(self, monkeypatch):
        """NEO-399's stage returns the upload untouched, so its box is the
        whole frame, like the other two identities."""
        _stub_gates(monkeypatch)
        monkeypatch.setattr(cropper.scan_meta, "is_card_sized_scan", lambda _b: None)
        monkeypatch.setattr(tiered, "fast_tiered_verdict", lambda _b: (None, "weak"))
        monkeypatch.setattr(quad, "quad_crop", lambda _b: quad.QuadResult(None, "no_quad"))
        monkeypatch.setattr(
            frame_content,
            "frame_content_identity",
            lambda _b, **_kw: frame_content.FrameContentResult(accepted=True, reason="ok"),
        )
        monkeypatch.setattr(cropper, "is_plausible_crop", _ok_validator)

        result = cropper.crop(
            image_bytes=_png((250, 350)), precropped_bytes=None, escalate_only=True
        )

        assert result.source == "frame_content"
        assert result.crop_box == boxes.full_frame(250, 350)

    def test_a_strategy_win_carries_the_box_it_recorded(self, monkeypatch):
        _stub_gates(monkeypatch)
        recorded = CropBox(100, 120, 80, 110, 5, 250, 350)

        def _strategy(_b):
            boxes.record(recorded)
            return _png((80, 110))

        _only_strategy(monkeypatch, _strategy)

        result = cropper.crop(image_bytes=_png((250, 350)), precropped_bytes=None)

        assert result.source == "tiered"
        assert result.crop_box == recorded

    def test_a_strategy_that_records_nothing_has_no_box(self, monkeypatch):
        _stub_gates(monkeypatch)
        _only_strategy(monkeypatch, lambda _b: _png((80, 110)))

        result = cropper.crop(image_bytes=_png((250, 350)), precropped_bytes=None)

        assert result.source == "tiered"
        assert result.crop_box is None

    def test_a_box_from_a_losing_stage_never_reaches_the_winner(self, monkeypatch):
        _stub_gates(monkeypatch)
        calls = {"n": 0}

        def _strategy(_b):
            calls["n"] += 1
            boxes.record(CropBox(10, 10, 5, 5, 0, 250, 350))
            return None  # declines after recording

        _only_strategy(monkeypatch, _strategy)

        result = cropper.crop(image_bytes=_png((250, 350)), precropped_bytes=None)

        assert calls["n"] == 1
        assert result.source == "passthrough"
        assert result.crop_box == boxes.full_frame(250, 350)

    def test_a_client_crop_has_no_box(self, monkeypatch):
        _stub_gates(monkeypatch)
        monkeypatch.setattr(cropper, "is_plausible_crop", _ok_validator)

        result = cropper.crop(image_bytes=_png((250, 350)), precropped_bytes=_png((200, 280)))

        assert result.source == "precropped"
        assert result.crop_box is None


class _Ok:
    ok = True
    reason = None


def _ok_validator(*_args, **_kwargs):
    return _Ok()


def _only_strategy(monkeypatch, fn) -> None:
    """Make `tiered` the one strategy, running `fn`, after a declined fast path."""
    monkeypatch.setattr(cropper, "is_plausible_crop", _ok_validator)
    monkeypatch.setattr(cropper.scan_meta, "is_card_sized_scan", lambda _b: None)
    monkeypatch.setattr(tiered, "fast_tiered_verdict", lambda _b: (None, "crop"))
    monkeypatch.setattr(quad, "quad_crop", lambda _b: quad.QuadResult(None, "no_quad"))
    monkeypatch.setattr(tiered, "tiered_crop", fn)
    for name in ("pil_trim", "sam", "haiku_bbox"):
        module = getattr(cropper, name)
        for attr in ("trim_dark", "trim_light", "sam_crop", "haiku_bbox_crop"):
            if hasattr(module, attr):
                monkeypatch.setattr(module, attr, lambda _b: None)
