"""Unit tests for the NEO-173 classical-only crop fast-path.

`tiered.fast_tiered_crop` runs NO BiRefNet inference. Its whole contract:
return the input bytes UNTOUCHED for an unambiguous pre-cropped card-aspect
identity frame (the ~80% scanner majority), else `None` so the caller
escalates to the full pipeline. Because it can only ever return the input or
`None` — never a new crop — it cannot ship a border-shaved or un-deskewed
crop; every crop, skew, die-cut, or ambiguous frame escalates.

Scenes are the same synthetic BGR canvases test_cropper_tiered.py uses: a
saturated card fill on a mid-gray background so the LAB background-distance
mask separates cleanly. A 700x980 canvas is card-aspect (0.714) so it reads
as a near_card_frame; a 1000x1000 canvas is square and never does.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest

from app.cropper import tiered
from app.cropper.tiered import fast_tiered_crop, fast_tiered_verdict

BG = (120, 120, 120)  # BGR mid-gray background
CARD = (30, 60, 140)  # BGR saturated card fill — far from BG in LAB


def _canvas(size: tuple[int, int], color: tuple = BG) -> np.ndarray:
    w, h = size
    return np.full((h, w, 3), color, np.uint8)


def _draw_card(img: np.ndarray, box: tuple[int, int, int, int], color: tuple = CARD) -> None:
    x0, y0, x1, y1 = box
    img[y0:y1, x0:x1] = color
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    cv2.rectangle(img, (x0 + 40, y0 + 40), (cx, cy), (200, 200, 200), -1)
    cv2.rectangle(img, (cx + 10, cy + 10), (x1 - 40, y1 - 40), (60, 160, 60), -1)


def _jpeg(img: np.ndarray, quality: int = 95) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    assert ok
    return bytes(buf)


def _frame_fill_jpeg(size: tuple[int, int] = (700, 980)) -> bytes:
    """A card that fills its card-aspect frame — the identity case."""
    w, h = size
    img = _canvas(size)
    _draw_card(img, (8, 8, w - 8, h - 8))
    return _jpeg(img)


def _small_card_jpeg(size: tuple[int, int] = (700, 980)) -> bytes:
    """A small card centered on a card-aspect frame with a wide background
    margin — a crop candidate, never identity."""
    w, h = size
    img = _canvas(size)
    cw, ch = 280, 400
    x0, y0 = (w - cw) // 2, (h - ch) // 2
    _draw_card(img, (x0, y0, x0 + cw, y0 + ch))
    return _jpeg(img)


@pytest.fixture(autouse=True)
def _forbid_birefnet(monkeypatch):
    """The fast path must never invoke BiRefNet. Any attempt fails the test."""

    def _boom(*_args, **_kwargs):
        raise AssertionError("fast_tiered_crop must not touch BiRefNet")

    monkeypatch.setattr(tiered, "birefnet_mask", _boom)
    monkeypatch.setattr(tiered, "_get_session", _boom)


class TestIdentityAccept:
    def test_frame_fill_card_aspect_returns_the_input_object_untouched(self):
        data = _frame_fill_jpeg()
        result = fast_tiered_crop(data)
        # The exact same bytes object — proof it is the input, not a re-encode.
        assert result is data

    def test_landscape_frame_fill_is_also_identity(self):
        data = _frame_fill_jpeg(size=(980, 700))
        assert fast_tiered_crop(data) is data


class TestEscalate:
    def test_small_card_on_wide_margin_escalates(self):
        # A real crop candidate — the fast path must decline (None), never crop.
        assert fast_tiered_crop(_small_card_jpeg()) is None

    def test_non_card_aspect_frame_escalates(self):
        # A square frame is not a card-aspect frame → never a pre-cropped card.
        img = _canvas((1000, 1000))
        _draw_card(img, (10, 10, 990, 990))
        assert fast_tiered_crop(_jpeg(img)) is None

    def test_blank_frame_with_no_components_escalates(self):
        # Uniform card-aspect frame: no classical component → not "frame".
        assert fast_tiered_crop(_jpeg(_canvas((700, 980)))) is None

    def test_undecodable_bytes_escalate_without_raising(self):
        assert fast_tiered_crop(b"not-an-image") is None


# ── NEO-399: the verdict behind the answer ───────────────────────────────

_INTAKE_DIR = (
    Path(__file__).resolve().parents[4] / "apps" / "web" / "playwright" / "fixtures" / "intake"
)


def _intake(name: str) -> bytes:
    path = _INTAKE_DIR / f"{name}.jpg"
    if not path.exists():
        pytest.skip(f"intake fixture not in this checkout: {path}")
    return path.read_bytes()


def _scenes() -> dict[str, bytes]:
    square = _canvas((1000, 1000))
    _draw_card(square, (10, 10, 990, 990))
    return {
        "frame_fill": _frame_fill_jpeg(),
        "landscape_frame_fill": _frame_fill_jpeg(size=(980, 700)),
        "small_card": _small_card_jpeg(),
        "square": _jpeg(square),
        "blank": _jpeg(_canvas((700, 980))),
        "undecodable": b"not-an-image",
    }


class TestFastTieredVerdict:
    """`fast_tiered_verdict` returns `fast_tiered_crop`'s answer plus the
    reason, so the frame-content stage can follow only `weak` frames."""

    def test_frame_fill_is_the_input_object_with_reason_frame(self):
        data = _frame_fill_jpeg()
        accepted, reason = fast_tiered_verdict(data)
        assert accepted is data
        assert reason == "frame"

    def test_non_card_aspect_frame_names_its_reason(self):
        img = _canvas((1000, 1000))
        _draw_card(img, (10, 10, 990, 990))
        assert fast_tiered_verdict(_jpeg(img)) == (None, "not_card_aspect")

    def test_undecodable_bytes_name_their_reason_without_raising(self):
        assert fast_tiered_verdict(b"not-an-image") == (None, "undecodable")

    @pytest.mark.parametrize("scene", sorted(_scenes()))
    def test_every_decline_is_none_with_a_known_reason(self, scene):
        accepted, reason = fast_tiered_verdict(_scenes()[scene])
        assert reason in tiered.FAST_VERDICT_REASONS
        assert (accepted is not None) == (reason == "frame")

    @pytest.mark.parametrize("scene", sorted(_scenes()))
    def test_fast_tiered_crop_is_unchanged_by_the_wrapper(self, scene):
        data = _scenes()[scene]
        accepted, _reason = fast_tiered_verdict(data)
        assert fast_tiered_crop(data) is accepted

    def test_a_real_frame_fill_scan_is_frame(self):
        data = _intake("01-mcfadden-front")
        accepted, reason = fast_tiered_verdict(data)
        assert accepted is data
        assert reason == "frame"
        assert fast_tiered_crop(data) is data

    @pytest.mark.parametrize(
        "name",
        ["02-mcfadden-back", "04-bowe-back", "05-bell-front", "06-bell-back", "08-bowe-again-back"],
    )
    def test_a_real_tight_scan_is_weak_and_still_escalates_here(self, name):
        data = _intake(name)
        assert fast_tiered_verdict(data) == (None, "weak")
        assert fast_tiered_crop(data) is None
