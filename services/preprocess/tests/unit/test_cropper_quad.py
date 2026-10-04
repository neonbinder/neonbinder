"""Unit tests for app.cropper.quad — the NEO-320 FAST-role quad crop.

`quad_crop` finds one card's four corners and warps it flat, and declines
with a named reason whenever its pixel content checks do not all agree. These
tests build synthetic scenes the way a camera or scanner would see a card: a
card face (border, printed inner panel, texture) warped onto a mat by a
perspective transform, then JPEG-encoded. Nothing here depends on where an
image came from; neither does the code under test.

Scene convention: BGR numpy canvases; `size` is (width, height). A dark mat
with mild noise stands in for a desk or scanner lid. Card faces have a light
printed border around a saturated inner panel, which is exactly the inner
rectangle a careless quad detector would return.
"""

from __future__ import annotations

import io

import cv2
import numpy as np
import pytest
from PIL import Image

from app.cropper import quad, tiered
from app.cropper.quad import DECLINE_REASONS, QuadResult, quad_crop

MAT = (48, 46, 44)  # BGR dark desk mat
WHITE_MAT = (236, 236, 236)  # BGR scanner-white bed
BORDER = (232, 232, 228)  # BGR the card's printed white border
PANEL = (150, 80, 30)  # BGR saturated inner panel


def _canvas(size: tuple[int, int], color: tuple = MAT, noise: float = 2.0) -> np.ndarray:
    w, h = size
    img = np.full((h, w, 3), color, np.float32)
    rng = np.random.default_rng(w * 7 + h)
    img += rng.normal(0.0, noise, img.shape)
    return np.clip(img, 0, 255).astype(np.uint8)


def _card_face(
    size: tuple[int, int] = (500, 700),
    border: tuple = BORDER,
    panel: tuple = PANEL,
    border_frac: float = 0.06,
) -> np.ndarray:
    """A portrait card face: printed border, inner panel, some content."""
    w, h = size
    face = np.full((h, w, 3), border, np.uint8)
    b = int(border_frac * w)
    face[b : h - b, b : w - b] = panel
    cv2.rectangle(face, (b + 40, b + 60), (w - b - 60, h // 2), (60, 170, 220), -1)
    cv2.circle(face, (w // 2, int(h * 0.62)), w // 6, (40, 40, 160), -1)
    cv2.rectangle(face, (b + 30, h - b - 110), (w - b - 30, h - b - 40), (20, 20, 20), -1)
    for i in range(5):
        y = h - b - 100 + i * 12
        cv2.line(face, (b + 50, y), (w - b - 50, y), (230, 230, 230), 2)
    return face


def _place(canvas: np.ndarray, face: np.ndarray, corners: np.ndarray) -> np.ndarray:
    """Warp `face` onto `canvas` so its corners land on `corners` (TL, TR, BR, BL)."""
    fh, fw = face.shape[:2]
    src = np.float32([[0, 0], [fw - 1, 0], [fw - 1, fh - 1], [0, fh - 1]])
    m = cv2.getPerspectiveTransform(src, np.float32(corners))
    h, w = canvas.shape[:2]
    warped = cv2.warpPerspective(face, m, (w, h), flags=cv2.INTER_LINEAR)
    mask = cv2.warpPerspective(np.full((fh, fw), 255, np.uint8), m, (w, h))
    out = canvas.copy()
    out[mask > 127] = warped[mask > 127]
    return out


def _rect_corners(cx: float, cy: float, w: float, h: float, angle_deg: float) -> np.ndarray:
    a = np.radians(angle_deg)
    rot = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
    pts = np.array([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]])
    return pts @ rot.T + np.array([cx, cy])


def _jpeg(img: np.ndarray, quality: int = 92) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    assert ok
    return bytes(buf)


def _size(jpeg: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(jpeg)) as im:
        return im.size


def _decode(jpeg: bytes) -> np.ndarray:
    return cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)


def _corner_error(found: np.ndarray, truth: np.ndarray) -> float:
    found = tiered.order_quad(np.asarray(found, np.float64))
    truth = tiered.order_quad(np.asarray(truth, np.float64))
    return float(np.max(np.linalg.norm(found - truth, axis=1)))


@pytest.fixture(autouse=True)
def _forbid_birefnet(monkeypatch):
    """The quad crop is FAST-role code and must never reach a model."""

    def _boom(*_args, **_kwargs):
        raise AssertionError("quad_crop must not touch BiRefNet")

    monkeypatch.setattr(tiered, "birefnet_mask", _boom)
    monkeypatch.setattr(tiered, "_get_session", _boom)


# ── Accepts ─────────────────────────────────────────────────────────────────


class TestAccepts:
    def test_tilted_card_on_a_mat_is_cropped_and_straightened(self):
        truth = _rect_corners(600, 800, 500, 700, angle_deg=8)
        scene = _place(_canvas((1200, 1600)), _card_face(), truth)

        result = quad_crop(_jpeg(scene))

        assert result.accepted, result.diagnostics
        assert result.reason == "ok"
        w, h = _size(result.crop_bytes)
        assert h > w, "the crop is portrait"
        assert abs(w / h - tiered.CARD_ASPECT) < 0.01
        assert _corner_error(result.quad, truth) < 6.0

    def test_perspective_card_is_cropped_to_the_card(self):
        # A phone held off-axis: the far (top) edge is shorter than the near one.
        truth = np.array([[370.0, 450.0], [830.0, 440.0], [872.0, 1150.0], [330.0, 1160.0]])
        scene = _place(_canvas((1200, 1600)), _card_face(), truth)

        result = quad_crop(_jpeg(scene))

        assert result.accepted, result.diagnostics
        assert _corner_error(result.quad, truth) < 8.0
        w, h = _size(result.crop_bytes)
        assert abs(w / h - tiered.CARD_ASPECT) < 0.03

    def test_the_crop_keeps_the_printed_border(self):
        """The warped crop's outer ring is the card's white border, not the
        mat and not the inner panel: neither loose nor shaved."""
        truth = _rect_corners(600, 800, 500, 700, angle_deg=-5)
        scene = _place(_canvas((1200, 1600)), _card_face(), truth)

        result = quad_crop(_jpeg(scene))

        assert result.accepted, result.diagnostics
        crop = _decode(result.crop_bytes).astype(np.float32)
        h, w = crop.shape[:2]
        t = max(3, int(0.02 * w))
        ring = np.concatenate(
            [
                crop[t : 2 * t, t:-t].reshape(-1, 3),
                crop[-2 * t : -t, t:-t].reshape(-1, 3),
                crop[t:-t, t : 2 * t].reshape(-1, 3),
                crop[t:-t, -2 * t : -t].reshape(-1, 3),
            ]
        )
        assert np.median(ring, axis=0).min() > 200, "outer band should be the white border"

    def test_landscape_card_comes_back_portrait(self):
        truth = _rect_corners(800, 600, 700, 500, angle_deg=3)
        face = cv2.rotate(_card_face(), cv2.ROTATE_90_CLOCKWISE)
        scene = _place(_canvas((1600, 1200)), face, truth)

        result = quad_crop(_jpeg(scene))

        assert result.accepted, result.diagnostics
        w, h = _size(result.crop_bytes)
        assert h > w

    def test_full_resolution_pixels_are_used(self):
        """Detection runs at work size; the crop comes from the original."""
        truth = _rect_corners(1200, 1600, 1000, 1400, angle_deg=6)
        scene = _place(_canvas((2400, 3200)), _card_face((1000, 1400)), truth)

        result = quad_crop(_jpeg(scene))

        assert result.accepted, result.diagnostics
        w, h = _size(result.crop_bytes)
        assert h > 1300, "crop must be cut from the full-resolution frame"
        assert _corner_error(result.quad, truth) < 12.0


# ── Declines ────────────────────────────────────────────────────────────────


class TestDeclines:
    def test_two_cards_decline_as_multi_card(self):
        canvas = _canvas((1800, 1300))
        scene = _place(canvas, _card_face(), _rect_corners(450, 650, 500, 700, 4))
        second = _card_face(panel=(30, 120, 60))
        scene = _place(scene, second, _rect_corners(1300, 650, 500, 700, -3))

        result = quad_crop(_jpeg(scene))

        assert not result.accepted
        assert result.reason == "multi_card"

    def test_white_border_on_a_white_bed_is_not_shaved_to_the_panel(self):
        """The card's white border matches the bed, so the strongest
        rectangle is the printed inner panel. Only a faint outer edge marks
        the real card — the shave the outer-line check exists for. The
        border is thin enough that the panel is itself card-shaped."""
        truth = _rect_corners(600, 800, 500, 700, angle_deg=0.6)
        face = _card_face(border_frac=0.03)
        scene = _place(_canvas((1200, 1600), WHITE_MAT, noise=1.0), face, truth)
        cv2.polylines(scene, [np.int32(np.round(truth))], True, (200, 200, 200), 1, cv2.LINE_AA)

        result = quad_crop(_jpeg(scene))

        assert not result.accepted
        assert result.reason == "shaved"

    def test_frame_that_is_already_one_card_is_not_cropped(self):
        """A pre-cropped card fills the frame; the only quad left inside it is
        its printed panel, and cropping to that would shave the border."""
        face = _card_face((1000, 1400), border_frac=0.035)

        result = quad_crop(_jpeg(face))

        assert not result.accepted
        assert result.reason == "tight_frame"

    @pytest.mark.parametrize("border_frac", [0.02, 0.06, 0.10])
    def test_frame_filling_card_is_never_cropped_whatever_its_border(self, border_frac):
        face = _card_face((1000, 1400), border_frac=border_frac)

        result = quad_crop(_jpeg(face))

        assert not result.accepted

    def test_quad_around_mat_and_card_is_declined_as_loose(self):
        """A card-shaped guide line on the mat surrounds the card: the
        largest quad then carries a band of mat inside it."""
        canvas = _canvas((1400, 1800))
        outline = _rect_corners(700, 900, 640, 896, angle_deg=0)
        cv2.polylines(canvas, [np.int32(np.round(outline))], True, (200, 200, 200), 3)
        scene = _place(canvas, _card_face(), _rect_corners(700, 900, 500, 700, angle_deg=0))

        result = quad_crop(_jpeg(scene))

        assert not result.accepted
        assert result.reason == "loose"

    def test_non_card_shaped_rectangle_is_not_a_quad(self):
        canvas = _canvas((1600, 1600))
        scene = _place(canvas, _card_face((700, 700)), _rect_corners(800, 800, 700, 700, 5))

        result = quad_crop(_jpeg(scene))

        assert not result.accepted
        assert result.reason == "no_quad"

    def test_card_matching_the_mat_has_no_supported_edges(self):
        face = _card_face(border=MAT, panel=MAT)
        scene = _place(_canvas((1200, 1600)), face, _rect_corners(600, 800, 500, 700, 4))

        result = quad_crop(_jpeg(scene))

        assert not result.accepted

    def test_empty_mat_finds_nothing(self):
        result = quad_crop(_jpeg(_canvas((1200, 1600))))

        assert not result.accepted
        assert result.reason == "no_quad"
        assert result.quad is None

    def test_undecodable_bytes_decline_without_raising(self):
        result = quad_crop(b"not an image")

        assert result == QuadResult(None, "undecodable")

    def test_internal_failure_declines_as_error(self, monkeypatch):
        def _boom(*_a, **_k):
            raise RuntimeError("boom")

        monkeypatch.setattr(quad, "_candidates", _boom)
        scene = _place(_canvas((1200, 1600)), _card_face(), _rect_corners(600, 800, 500, 700, 5))

        result = quad_crop(_jpeg(scene))

        assert result.reason == "error"
        assert not result.accepted

    def test_every_reason_is_declared(self):
        assert set(DECLINE_REASONS) >= {
            "undecodable",
            "no_quad",
            "multi_card",
            "tight_frame",
            "shaved",
            "loose",
            "weak_edges",
            "off_aspect",
            "error",
        }
