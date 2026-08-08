"""Unit tests for app.cropper.sam.

The heavy SAM inference path needs torch + transformers + the 375MB model,
which we can't realistically load in unit tests. Those paths are covered
by smoke tests running against the deployed service.

This module exercises:
- The pure-Python / pure-cv2 helpers (_open_and_resize, _pil_to_bgr,
  _bgr_to_jpeg_bytes, _compute_rotation_angle, _rotate_and_crop,
  _pick_card_mask)
- sam_crop's outermost error paths (bad bytes, mock-failing helpers) so
  we verify it returns None rather than crashing the cascade
"""

from __future__ import annotations

import io

import cv2
import numpy as np
import pytest
from PIL import Image

from app.cropper import sam
from app.cropper.sam import (
    MAX_SAM_SIDE,
    _bgr_to_jpeg_bytes,
    _compute_rotation_angle,
    _open_and_resize,
    _pick_card_mask,
    _pil_to_bgr,
    _rotate_and_crop,
    sam_crop,
)


def _card_on_background_bgr() -> np.ndarray:
    """Build a 1200x1600 BGR image with a 800x1100 white card on black."""
    img = np.zeros((1600, 1200, 3), dtype=np.uint8)
    img[250:1350, 200:1000] = 255  # white card
    return img


def _jpeg_bytes_from_bgr(bgr: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    assert ok
    return bytes(buf)


class TestOpenAndResize:
    def test_small_image_kept_as_is(self):
        img = Image.new("RGB", (800, 1100), "white")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)
        result_img, ratio = _open_and_resize(buf.getvalue())
        assert result_img.size == (800, 1100)
        assert ratio == 1.0

    def test_oversized_image_downscaled_longest_edge(self):
        img = Image.new("RGB", (4500, 3000), "white")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)
        result_img, ratio = _open_and_resize(buf.getvalue())
        # Longest edge should come down to MAX_SAM_SIDE.
        assert max(result_img.size) == MAX_SAM_SIDE
        assert ratio < 1.0

    def test_invalid_bytes_raises(self):
        # PIL raises UnidentifiedImageError specifically; sam_crop's outer
        # try/except catches "Exception" on purpose, but the helper itself
        # should surface a specific PIL error when called directly.
        from PIL import UnidentifiedImageError

        with pytest.raises(UnidentifiedImageError):
            _open_and_resize(b"not an image")


class TestConversions:
    def test_pil_to_bgr_channel_order(self):
        # Red in RGB; BGR output should have blue first (255 at channel 2).
        img = Image.new("RGB", (2, 2), (255, 0, 0))
        bgr = _pil_to_bgr(img)
        assert bgr.shape == (2, 2, 3)
        # OpenCV BGR: pure red (255,0,0) RGB → (0,0,255) BGR.
        assert np.all(bgr[:, :, 0] == 0)
        assert np.all(bgr[:, :, 1] == 0)
        assert np.all(bgr[:, :, 2] == 255)

    def test_bgr_to_jpeg_bytes_roundtrip(self):
        bgr = _card_on_background_bgr()
        jpeg = _bgr_to_jpeg_bytes(bgr)
        # Round-trip through PIL to confirm valid JPEG.
        img = Image.open(io.BytesIO(jpeg))
        assert img.size == (1200, 1600)


class TestRotateAndCrop:
    def test_axis_aligned_pts_no_rotation(self):
        """Card already axis-aligned: rotation should be ~0, crop is just the bbox."""
        image = _card_on_background_bgr()
        # Corners of the white card region, in TL,TR,BR,BL order.
        pts = np.array(
            [[200, 250], [1000, 250], [1000, 1350], [200, 1350]],
            dtype=np.float32,
        )
        angle, _ = _compute_rotation_angle(pts)
        assert abs(angle) < 1.0  # ≈ 0

        cropped, _rotated_pts = _rotate_and_crop(image, pts, padding=0)
        # Cropped should match the white-card dimensions within 1px slack.
        h, w = cropped.shape[:2]
        assert 799 <= w <= 801
        assert 1099 <= h <= 1101

    def test_tilted_rect_gets_rotated(self):
        """45° rotated rect produces a non-trivial rotation angle."""
        # Square rotated 45°: corners at the cardinal compass points.
        pts = np.array(
            [[500, 100], [900, 500], [500, 900], [100, 500]],
            dtype=np.float32,
        )
        angle, _ = _compute_rotation_angle(pts)
        assert abs(angle) > 1.0


class TestPickCardMask:
    @staticmethod
    def _card_mask(shape=(1600, 1200)) -> np.ndarray:
        """800x1100 card region inside a 1200x1600 canvas → area 27% of frame."""
        m = np.zeros(shape, dtype=bool)
        m[250:1350, 200:1000] = True
        return m

    def test_accepts_card_shaped_high_iou_mask(self):
        candidates = [(self._card_mask(), 0.9)]
        pts, score = _pick_card_mask(candidates, pil_size=(1200, 1600))
        assert pts is not None
        assert pts.shape == (4, 2)
        assert score == 0.9

    def test_rejects_low_iou(self):
        candidates = [(self._card_mask(), 0.3)]
        pts, score = _pick_card_mask(candidates, pil_size=(1200, 1600))
        assert pts is None and score is None

    def test_rejects_wrong_aspect(self):
        # Make a square mask — way off card aspect.
        square = np.zeros((1600, 1200), dtype=bool)
        square[400:1000, 300:900] = True
        candidates = [(square, 0.9)]
        pts, score = _pick_card_mask(candidates, pil_size=(1200, 1600))
        assert pts is None

    def test_rejects_tiny_mask(self):
        # 50x70 mask out of 1200x1600 canvas = 0.2% → below MIN_AREA_FRACTION.
        tiny = np.zeros((1600, 1200), dtype=bool)
        tiny[100:170, 100:150] = True
        candidates = [(tiny, 0.9)]
        pts, score = _pick_card_mask(candidates, pil_size=(1200, 1600))
        assert pts is None

    def test_picks_best_when_multiple_candidates(self):
        # Two masks: one is card-shaped high IOU, one is a non-card-shape
        # high IOU. Card one should win.
        card = self._card_mask()
        square = np.zeros((1600, 1200), dtype=bool)
        square[400:1000, 300:900] = True
        pts, score = _pick_card_mask(
            [(square, 0.99), (card, 0.8)],
            pil_size=(1200, 1600),
        )
        assert pts is not None  # card wins — square rejected for aspect


class TestSamCropErrorPaths:
    def test_unreadable_bytes_returns_none(self):
        # _open_and_resize raises → sam_crop catches and returns None.
        assert sam_crop(b"definitely not an image") is None

    def test_model_load_failure_returns_none(self, monkeypatch):
        def _boom():
            raise RuntimeError("HF download failed")

        monkeypatch.setattr(sam, "_load_model", _boom)

        # Build a real image so _open_and_resize succeeds.
        img = Image.new("RGB", (1200, 1600), "white")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)

        assert sam_crop(buf.getvalue()) is None

    def test_no_mask_passes_filters_returns_none(self, monkeypatch):
        """Mask generation returns low-score candidates → no winner → None."""
        monkeypatch.setattr(sam, "_load_model", lambda: (object(), object()))
        monkeypatch.setattr(
            sam,
            "_generate_masks",
            lambda _img, _m, _p: [(np.zeros((1600, 1200), dtype=bool), 0.1)],
        )

        img = Image.new("RGB", (1200, 1600), "white")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)

        assert sam_crop(buf.getvalue()) is None

    def test_mask_generation_exception_returns_none(self, monkeypatch):
        monkeypatch.setattr(sam, "_load_model", lambda: (object(), object()))

        def _boom(_img, _m, _p):
            raise RuntimeError("torch crash")

        monkeypatch.setattr(sam, "_generate_masks", _boom)

        img = Image.new("RGB", (1200, 1600), "white")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)

        assert sam_crop(buf.getvalue()) is None

    def test_happy_path_with_mocked_mask(self, monkeypatch):
        """Full sam_crop flow with a mocked good mask."""
        monkeypatch.setattr(sam, "_load_model", lambda: (object(), object()))

        # Build a 1200x1600 image. SAM would downscale to MAX_SAM_SIDE
        # internally. _open_and_resize returns (img, ratio). Mask is computed
        # on the resized image, so return a mask matching that size.
        def _fake_masks(pil_img, _m, _p):
            # 25% card region in the resized image.
            mw, mh = pil_img.size
            mask = np.zeros((mh, mw), dtype=bool)
            mask[int(mh * 0.1) : int(mh * 0.85), int(mw * 0.15) : int(mw * 0.85)] = True
            return [(mask, 0.95)]

        monkeypatch.setattr(sam, "_generate_masks", _fake_masks)

        img = Image.new("RGB", (1200, 1600), "white")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)

        result = sam_crop(buf.getvalue())
        assert result is not None
        # Round-trip through PIL to confirm valid JPEG.
        out_img = Image.open(io.BytesIO(result))
        assert out_img.size[0] > 0 and out_img.size[1] > 0
