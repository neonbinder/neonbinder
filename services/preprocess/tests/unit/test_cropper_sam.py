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

import contextlib
import io
import sys
from types import SimpleNamespace

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


# ── NEO-315: batched probes, thread count, startup warm-up ───────────────────
#
# The real SAM path needs torch + transformers + the 375MB weights, which the
# unit suite never loads. These fakes pin the CALL SHAPE the batching relies
# on (one processor call, one embedding, one decoder pass, candidate order);
# that the real decoder's batched output matches the old per-probe loop is a
# numerical property covered by the deployed preview / crop matrix, not here.


class _T:
    """Just enough of a torch tensor for `_generate_masks`' post-processing."""

    def __init__(self, arr) -> None:
        self.arr = np.asarray(arr)

    def cpu(self) -> _T:
        return self

    def numpy(self) -> np.ndarray:
        return self.arr

    def item(self) -> float:
        return float(self.arr)

    def __getitem__(self, idx) -> _T:
        return _T(self.arr[idx])


class _FakeTorch:
    no_grad = staticmethod(contextlib.nullcontext)


class _FakeProcessor:
    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.post_calls = 0

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        return {
            "pixel_values": "PIXELS",
            "input_points": ("POINTS", kwargs.get("input_points")),
            "input_labels": ("LABELS", kwargs.get("input_labels")),
            "original_sizes": _T([[20, 30]]),
            "reshaped_input_sizes": _T([[20, 30]]),
        }

    def post_process_masks(self, pred_masks, original_sizes, reshaped_sizes):
        self.post_calls += 1
        return [pred_masks]


class _FakeModel:
    def __init__(self, n_probes: int) -> None:
        self.n = n_probes
        self.embed_calls = 0
        self.decode_calls: list[dict] = []

    def get_image_embeddings(self, pixel_values):
        assert pixel_values == "PIXELS"
        self.embed_calls += 1
        return "EMBEDDINGS"

    def __call__(self, **kwargs):
        self.decode_calls.append(kwargs)
        masks = np.zeros((self.n, 3, 4, 4), dtype=np.float32)
        scores = np.zeros((1, self.n, 3), dtype=np.float32)
        for p in range(self.n):
            for k in range(3):
                masks[p, k, 0, 0] = 1.0 if (p + k) % 2 else 0.0
                scores[0, p, k] = p + k / 10
        return SimpleNamespace(pred_masks=_T(masks), iou_scores=_T(scores))


class TestBatchedProbes:
    def test_probe_prompts_are_one_batch_of_single_point_prompts(self):
        points, labels = sam._probe_prompts(200, 100)
        assert len(points) == 1 and len(labels) == 1  # one image
        assert len(points[0]) == len(sam.PROBE_POINTS_FRACTIONS)
        assert points[0][0] == [[100.0, 50.0]]  # centre probe, one point
        assert all(len(prompt) == 1 for prompt in points[0])
        assert labels[0] == [[1]] * len(sam.PROBE_POINTS_FRACTIONS)

    def test_one_processor_call_one_embedding_one_decoder_pass(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "torch", _FakeTorch)
        n = len(sam.PROBE_POINTS_FRACTIONS)
        processor, model = _FakeProcessor(), _FakeModel(n)

        results = sam._generate_masks(Image.new("RGB", (30, 20)), model, processor)

        assert len(processor.calls) == 1
        assert processor.calls[0]["input_points"] == sam._probe_prompts(30, 20)[0]
        assert model.embed_calls == 1
        assert len(model.decode_calls) == 1
        assert model.decode_calls[0]["image_embeddings"] == "EMBEDDINGS"
        assert processor.post_calls == 1
        # Same candidate order as the old per-probe loop: probe-major, then
        # SAM's three multimask outputs.
        assert len(results) == 3 * n
        assert [score for _m, score in results] == pytest.approx(
            [p + k / 10 for p in range(n) for k in range(3)]
        )
        assert results[1][0].dtype == bool
        assert results[1][0][0, 0] is np.True_


class TestThreadsAndWarmUp:
    def test_thread_count_is_capped_at_four(self, monkeypatch):
        monkeypatch.setattr(sam.os, "cpu_count", lambda: 16)
        assert sam._torch_thread_count() == 4
        monkeypatch.setattr(sam.os, "cpu_count", lambda: 2)
        assert sam._torch_thread_count() == 2
        monkeypatch.setattr(sam.os, "cpu_count", lambda: None)
        assert sam._torch_thread_count() == 1

    def test_warm_up_loads_and_runs_one_small_pass(self, monkeypatch):
        loaded = (object(), object())
        seen: list[tuple] = []
        monkeypatch.setattr(sam, "_load_model", lambda: loaded)
        monkeypatch.setattr(
            sam, "_generate_masks", lambda img, m, p: seen.append((img.size, m, p)) or []
        )

        sam.warm_up()

        assert seen == [((64, 64), loaded[0], loaded[1])]

    def test_is_model_loaded_tracks_the_cache(self, monkeypatch):
        monkeypatch.setattr(sam, "_model", None)
        assert sam.is_model_loaded() is False
        monkeypatch.setattr(sam, "_model", object())
        assert sam.is_model_loaded() is True
