"""Unit tests for app.cropper.tiered — the ported NEO-161 tiered pipeline.

Everything runs on small synthetic numpy-drawn scenes. The BiRefNet stage
is always faked (`tiered.birefnet_mask` stubbed, or `rembg.remove` /
`rembg.new_session` monkeypatched) — unit tests must never download model
weights or touch the network; `tests/unit/conftest.py` enforces that by
refusing real session creation.

Scene conventions: BGR numpy canvases, mid-gray background, a saturated
card fill so the LAB background-distance mask separates cleanly. A
1000x1000 canvas stays at scale 1.0 (WORK_LONG=1200), which keeps
detection space == full space unless a test is specifically about the
work→full mapping.
"""

from __future__ import annotations

import io

import cv2
import numpy as np
import pytest
from PIL import Image

from app.cropper import tiered
from app.cropper.tiered import (
    CARD_ASPECT,
    PASS_SCORE,
    _bg_distance_mask,
    _edge_mask,
    _get_session,
    analyze,
    birefnet_mask,
    components,
    frame_echo,
    line_fit_quad,
    passes,
    should_identity,
    tiered_crop,
    warp_rect_card,
)

BG = (120, 120, 120)  # BGR mid-gray background
CARD = (30, 60, 140)  # BGR saturated card fill — far from BG in LAB


def _canvas(size: tuple[int, int] = (1000, 1000), color: tuple = BG) -> np.ndarray:
    """Solid canvas. `size` is (width, height); returns HxWx3 BGR."""
    w, h = size
    return np.full((h, w, 3), color, np.uint8)


def _draw_card(img: np.ndarray, box: tuple[int, int, int, int], color: tuple = CARD) -> None:
    """Fill `box` = (x0, y0, x1, y1) with the card color plus light texture."""
    x0, y0, x1, y1 = box
    img[y0:y1, x0:x1] = color
    # Interior texture so crops aren't uniform (and Canny has edges to find).
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    cv2.rectangle(img, (x0 + 40, y0 + 40), (cx, cy), (200, 200, 200), -1)
    cv2.rectangle(img, (cx + 10, cy + 10), (x1 - 40, y1 - 40), (60, 160, 60), -1)


def _jpeg(img: np.ndarray, quality: int = 95) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    assert ok
    return bytes(buf)


def _decode_size(jpeg: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(jpeg)) as out:
        return out.size  # (w, h)


def _rect_mask(shape_hw: tuple[int, int], box: tuple[int, int, int, int]) -> np.ndarray:
    mask = np.zeros(shape_hw, np.uint8)
    x0, y0, x1, y1 = box
    mask[y0:y1, x0:x1] = 255
    return mask


@pytest.fixture
def stub_birefnet(monkeypatch):
    """Replace `tiered.birefnet_mask` with a fake; returns the call log.

    Default fake finds nothing (zeros mask). Pass `mask_fn(work) -> mask`
    to control what BiRefNet "sees".
    """

    def _install(mask_fn=None) -> list:
        calls: list = []

        def _fake(work: np.ndarray) -> np.ndarray:
            calls.append(work.shape)
            if mask_fn is None:
                return np.zeros(work.shape[:2], np.uint8)
            return mask_fn(work)

        monkeypatch.setattr(tiered, "birefnet_mask", _fake)
        return calls

    return _install


# ── Classical happy path ────────────────────────────────────────────────────


class TestClassicalPath:
    def test_card_on_background_produces_snapped_portrait_crop(self, stub_birefnet):
        calls = stub_birefnet()  # BiRefNet "sees" nothing → classical kept
        img = _canvas()
        _draw_card(img, (250, 150, 750, 850))  # 500x700 — card aspect

        result = tiered_crop(_jpeg(img))

        assert result is not None
        w, h = _decode_size(result)
        assert 495 <= w <= 520
        assert 695 <= h <= 720
        # Snapped to exactly 2.5:3.5 (within integer rounding).
        assert abs(w / h - CARD_ASPECT) < 0.01
        # A classical gate-pass gets BiRefNet verification — the verify
        # stage must have consulted the semantic mask.
        assert len(calls) == 1

    def test_final_crop_pixels_come_from_the_full_resolution_original(self, stub_birefnet):
        """Detection runs at WORK_LONG; the crop must not be capped there.

        A 2400px canvas detects on a 1200px work copy; a crop returned in
        work coordinates would be ~500x700. The real card is 1000x1400.
        """
        stub_birefnet()
        img = _canvas(size=(2400, 2400))
        _draw_card(img, (600, 300, 1600, 1700))  # 1000x1400 at full res

        result = tiered_crop(_jpeg(img))

        assert result is not None
        w, h = _decode_size(result)
        assert w >= 990, "crop came back at detection resolution"
        assert h >= 1390
        assert abs(w / h - CARD_ASPECT) < 0.01

    def test_rotated_card_is_deskewed_by_the_quad_route(self, stub_birefnet):
        stub_birefnet()
        img = _canvas()
        box = cv2.boxPoints(((500.0, 500.0), (500.0, 700.0), 8.0)).astype(np.int32)
        cv2.fillPoly(img, [box], CARD)
        cv2.rectangle(img, (420, 420), (580, 580), (200, 200, 200), -1)  # texture

        result = tiered_crop(_jpeg(img))

        assert result is not None
        w, h = _decode_size(result)
        # Axis-aligned portrait card again — rotation removed by one warp.
        assert 485 <= w <= 520
        assert 685 <= h <= 725
        assert abs(w / h - CARD_ASPECT) < 0.01

    def test_unreadable_bytes_decline(self):
        assert tiered_crop(b"definitely not an image") is None

    def test_split_mask_fragments_are_merged_into_one_card(self, stub_birefnet, monkeypatch):
        """Union-find on padded bboxes: two fragments 20px apart are one card."""
        stub_birefnet()
        img = _canvas()
        _draw_card(img, (250, 150, 750, 850))
        split = _rect_mask((1000, 1000), (250, 150, 750, 490))
        split |= _rect_mask((1000, 1000), (250, 510, 750, 850))
        monkeypatch.setattr(tiered, "classical_candidates", lambda _w: [split])

        result = tiered_crop(_jpeg(img))

        assert result is not None
        w, h = _decode_size(result)
        assert 495 <= w <= 520, "fragments were not merged"
        assert 695 <= h <= 720


# ── Geometry ────────────────────────────────────────────────────────────────


class TestGeometry:
    def test_line_fit_recovers_a_clean_rectangle(self):
        hull = cv2.convexHull(
            np.array([[250, 150], [750, 150], [750, 850], [250, 850]], np.int32).reshape(-1, 1, 2)
        )
        rect = cv2.minAreaRect(hull)
        quad, _resid = line_fit_quad(hull, rect)
        # Every true corner is (near) a quad corner.
        for corner in [(250, 150), (750, 150), (750, 850), (250, 850)]:
            dists = np.linalg.norm(quad - np.array(corner, dtype=np.float64), axis=1)
            assert dists.min() < 3.0

    def test_dragged_corner_falls_back_to_the_oriented_box(self):
        """A trapezoid's fitted corners sit ~14 degrees off 90 — the quad
        would shear the card, so the box (which cannot shear) is used."""
        edges = []
        corners = [(400, 200), (600, 200), (750, 800), (250, 800)]
        for i in range(4):
            p0 = np.array(corners[i], np.float64)
            p1 = np.array(corners[(i + 1) % 4], np.float64)
            for t in np.linspace(0, 1, 200, endpoint=False):
                edges.append(p0 + t * (p1 - p0))
        pts = np.array(edges, np.float32).reshape(-1, 1, 2)
        hull = cv2.convexHull(pts)
        rect = cv2.minAreaRect(pts)

        quad, _resid = line_fit_quad(hull, rect)

        box = cv2.boxPoints(rect).astype(np.float64)
        for corner in box:
            dists = np.linalg.norm(quad - corner, axis=1)
            assert dists.min() < 1e-3, "expected the box points, got a fitted quad"

    def test_warp_snaps_a_near_card_aspect_quad_to_exact_ratio(self):
        img = _canvas()
        quad = np.array([[250, 150], [750, 150], [750, 850], [250, 850]], np.float64)
        crop, aspect, snapped = warp_rect_card(img, quad, 0.0)
        assert snapped is True
        assert aspect == pytest.approx(500 / 700, abs=1e-6)
        th, tw = crop.shape[:2]
        assert tw == round(th * CARD_ASPECT)

    def test_warp_keeps_a_measured_aspect_outside_the_snap_window(self):
        img = _canvas()
        quad = np.array([[250, 150], [750, 150], [750, 910], [250, 910]], np.float64)
        crop, aspect, snapped = warp_rect_card(img, quad, 0.0)
        assert snapped is False
        assert aspect == pytest.approx(500 / 760, abs=1e-3)
        th, tw = crop.shape[:2]
        assert (tw, th) == (500, 760)

    def test_low_rectangularity_routes_to_the_shape_preserving_diecut(self):
        # Octagon: 500x700 rect with 140px corner cuts → hull/rect ≈ 0.89.
        octagon = np.array(
            [
                [390, 150],
                [610, 150],
                [750, 290],
                [750, 710],
                [610, 850],
                [390, 850],
                [250, 710],
                [250, 290],
            ],
            np.int32,
        )
        mask = np.zeros((1000, 1000), np.uint8)
        cv2.fillPoly(mask, [octagon], 255)
        img = _canvas()
        cv2.fillPoly(img, [octagon], CARD)

        lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
        comps = analyze(mask, img, tiered.border_bg_lab(lab))

        assert len(comps) == 1
        assert comps[0]["route"] == "diecut"
        assert comps[0]["rectangularity"] < 0.92
        assert passes(comps[0]) is True  # rect ≥ 0.80 and aspect_dev ≤ 0.05

    def test_diecut_crop_preserves_the_cut_corners_end_to_end(self, stub_birefnet):
        stub_birefnet()
        octagon = np.array(
            [
                [390, 150],
                [610, 150],
                [750, 290],
                [750, 710],
                [610, 850],
                [390, 850],
                [250, 710],
                [250, 290],
            ],
            np.int32,
        )
        img = _canvas()
        cv2.fillPoly(img, [octagon], CARD)
        cv2.rectangle(img, (420, 420), (580, 580), (200, 200, 200), -1)

        result = tiered_crop(_jpeg(img))

        assert result is not None
        with Image.open(io.BytesIO(result)) as out:
            w, h = out.size
            corner = out.getpixel((4, 4))
            center = out.getpixel((w // 2, h // 2))
        assert 495 <= w <= 520
        assert 695 <= h <= 720
        # Shape-preserving: the cut corner still shows background, and no
        # perspective warp re-invented a full rectangle.
        assert all(abs(c - 120) < 40 for c in corner), f"corner not background: {corner}"
        assert all(abs(c - e) < 45 for c, e in zip(center, (200, 200, 200), strict=True))


# ── Gates ───────────────────────────────────────────────────────────────────


def _quad_comp(**overrides) -> dict:
    comp = {
        "route": "quad",
        "frame_echo": False,
        "score": 0.9,
        "snapped": True,
        "aspect": 0.7143,
        "aspect_dev": 0.0,
        "rectangularity": 0.99,
    }
    comp.update(overrides)
    return comp


class TestGates:
    def test_snapped_quad_passes(self):
        assert passes(_quad_comp()) is True

    def test_unsnapped_quad_inside_the_slab_window_passes(self):
        assert passes(_quad_comp(snapped=False, aspect=0.585)) is True

    @pytest.mark.parametrize("aspect", [0.55, 0.62, 0.68])
    def test_unsnapped_quad_outside_the_slab_window_fails(self, aspect):
        assert passes(_quad_comp(snapped=False, aspect=aspect)) is False

    def test_low_score_fails_regardless_of_shape(self):
        assert passes(_quad_comp(score=PASS_SCORE - 0.01)) is False

    def test_frame_echo_never_passes(self):
        assert passes(_quad_comp(frame_echo=True, score=0.99)) is False

    @pytest.mark.parametrize(
        "rectangularity,aspect_dev,expected",
        [
            (0.85, 0.03, True),
            (0.79, 0.03, False),  # too ragged for a die-cut
            (0.85, 0.06, False),  # too far off card aspect
        ],
    )
    def test_diecut_gate(self, rectangularity, aspect_dev, expected):
        comp = _quad_comp(
            route="diecut",
            snapped=False,
            rectangularity=rectangularity,
            aspect_dev=aspect_dev,
        )
        assert passes(comp) is expected

    def test_frame_echo_geometry(self):
        # The whole frame handed back → echo; a centered card → not.
        assert frame_echo(((500, 500), (1000, 1000), 0.0), (1000, 1000)) is True
        assert frame_echo(((500, 500), (500, 700), 0.0), (1000, 1000)) is False

    def test_frame_shaped_detection_is_demoted_and_gated_out(self):
        # Card-aspect work so the aspect term can't hide the demotion.
        img = np.full((1001, 715, 3), CARD, np.uint8)
        cv2.rectangle(img, (100, 100), (600, 800), (200, 200, 200), -1)
        mask = np.full((1001, 715), 255, np.uint8)
        lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)

        comps = analyze(mask, img, tiered.border_bg_lab(lab))

        assert len(comps) == 1
        assert comps[0]["frame_echo"] is True
        assert passes(comps[0]) is False

    def test_components_drops_specks(self):
        mask = _rect_mask((1000, 1000), (250, 150, 750, 850))
        mask |= _rect_mask((1000, 1000), (20, 20, 40, 40))  # 400px speck
        cnts = components(mask, 1000 * 1000)
        assert len(cnts) == 1

    def test_bg_distance_mask_declines_on_a_uniform_image(self):
        assert _bg_distance_mask(_canvas(), 0.5) is None

    def test_edge_mask_declines_on_a_uniform_image(self):
        assert _edge_mask(_canvas()) is None


# ── Pre-cropped identity guard ──────────────────────────────────────────────


class TestIdentityGuard:
    """Card-aspect input frames are probably already cropped."""

    @staticmethod
    def _card_aspect_scene() -> np.ndarray:
        """A 715x1001 frame that IS the card: white, with small text marks."""
        img = np.full((1001, 715, 3), (245, 245, 245), np.uint8)
        for y in range(120, 900, 90):
            cv2.rectangle(img, (80, y), (240, y + 12), (40, 40, 40), -1)
            cv2.rectangle(img, (300, y + 30), (500, y + 40), (40, 40, 40), -1)
        return img

    def test_full_bleed_card_returns_input_with_birefnet_casting_the_deciding_vote(
        self, stub_birefnet
    ):
        # Classical finds only text specks (weak). BiRefNet then sees the
        # whole frame as the object — the input IS the card → identity, and
        # identity returns the input bytes untouched (never re-encoded), so
        # the cascade ends with the input rather than letting pil_trim shave
        # the card's own border.
        calls = stub_birefnet(lambda work: np.full(work.shape[:2], 255, np.uint8))
        src = _jpeg(self._card_aspect_scene())

        result = tiered_crop(src)

        assert result == src
        assert len(calls) == 1, "identity must not be settled by classical evidence alone"

    def test_full_bleed_card_returns_input_when_birefnet_finds_nothing_either(self, stub_birefnet):
        calls = stub_birefnet()  # zeros — no object at all
        src = _jpeg(self._card_aspect_scene())
        result = tiered_crop(src)
        assert result == src
        assert len(calls) == 1

    def test_strong_inner_card_in_a_card_aspect_frame_is_still_cropped(self, stub_birefnet):
        # A photo can coincidentally be card-aspect while genuinely
        # containing a smaller card. Strong quad + verified-uniform margin
        # → crop, not identity.
        stub_birefnet()
        img = _canvas(size=(715, 1001))
        _draw_card(img, (200, 150, 560, 654))  # 360x504 — card aspect

        result = tiered_crop(_jpeg(img))

        assert result is not None
        w, h = _decode_size(result)
        assert 350 <= w <= 375
        assert 495 <= h <= 520

    def test_card_aspect_frame_with_weak_off_aspect_content_returns_input(self, stub_birefnet):
        # Inner rect at aspect 0.68: classical evidence is strong enough to
        # veto identity but the QC gate rejects it (no snap, not slab), so
        # the BiRefNet fallback runs; it finds nothing → identity wins on the
        # card-aspect frame and the input comes back untouched.
        calls = stub_birefnet()
        img = _canvas(size=(715, 1001))
        _draw_card(img, (160, 200, 560, 788))  # 400x588 → aspect 0.68
        src = _jpeg(img)

        result = tiered_crop(src)

        assert result == src
        assert len(calls) == 1

    def test_should_identity_reasons(self):
        img = _canvas(size=(715, 1001))
        lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
        bg = tiered.border_bg_lab(lab)

        # No components at all → weak.
        assert should_identity([], img, lab, bg) == (True, "weak")

        # The detection IS the frame → settled, 'frame'.
        frame_mask = np.full((1001, 715), 255, np.uint8)
        frame_comps = analyze(frame_mask, img, bg)
        assert should_identity(frame_comps, img, lab, bg) == (True, "frame")

        # Strong inner card on a uniform margin → not identity.
        card_img = _canvas(size=(715, 1001))
        _draw_card(card_img, (200, 150, 560, 654))
        card_lab = cv2.cvtColor(card_img, cv2.COLOR_BGR2LAB).astype(np.float32)
        card_bg = tiered.border_bg_lab(card_lab)
        card_mask = _rect_mask((1001, 715), (200, 150, 560, 654))
        card_comps = analyze(card_mask, card_img, card_bg)
        identity, reason = should_identity(card_comps, card_img, card_lab, card_bg)
        assert identity is False
        assert reason == ""

        # Same detection, but the margin is full of structure → 'margin'
        # (cropping would eat whatever the margin actually is).
        rng = np.random.default_rng(42)
        noisy = rng.integers(0, 255, (1001, 715, 3), dtype=np.uint8)
        noisy[150:654, 200:560] = CARD
        noisy_lab = cv2.cvtColor(noisy, cv2.COLOR_BGR2LAB).astype(np.float32)
        noisy_bg = tiered.border_bg_lab(noisy_lab)
        noisy_comps = analyze(card_mask, noisy, noisy_bg)
        identity, reason = should_identity(noisy_comps, noisy, noisy_lab, noisy_bg)
        assert identity is True
        assert reason == "margin"


# ── BiRefNet fallback + verify stage ────────────────────────────────────────


class TestBirefnetTiers:
    def test_fallback_runs_when_classical_finds_no_mask(self, stub_birefnet, monkeypatch):
        img = _canvas()
        _draw_card(img, (250, 150, 750, 850))
        monkeypatch.setattr(tiered, "classical_candidates", lambda _w: [])
        calls = stub_birefnet(lambda work: _rect_mask(work.shape[:2], (250, 150, 750, 850)))

        result = tiered_crop(_jpeg(img))

        assert result is not None
        assert len(calls) == 1
        w, h = _decode_size(result)
        assert 495 <= w <= 520
        assert 695 <= h <= 720

    def test_verify_stage_takes_birefnet_when_classical_shaved_the_border(
        self, stub_birefnet, monkeypatch
    ):
        # Classical locks onto an inner boundary (border matches background,
        # dark-on-dark); BiRefNet sees the true, materially larger card
        # (1.18x area > the 1.06x threshold) → take the bigger truth.
        img = _canvas()
        _draw_card(img, (250, 150, 750, 850))
        shaved = _rect_mask((1000, 1000), (270, 178, 730, 822))  # 460x644
        monkeypatch.setattr(tiered, "classical_candidates", lambda _w: [shaved])
        stub_birefnet(lambda work: _rect_mask(work.shape[:2], (250, 150, 750, 850)))

        result = tiered_crop(_jpeg(img))

        assert result is not None
        w, _h = _decode_size(result)
        assert w >= 490, "verify stage did not take BiRefNet's larger card"

    def test_verify_stage_keeps_classical_when_birefnet_is_comparable(
        self, stub_birefnet, monkeypatch
    ):
        img = _canvas()
        _draw_card(img, (250, 150, 750, 850))
        shaved = _rect_mask((1000, 1000), (270, 178, 730, 822))  # 460x644
        monkeypatch.setattr(tiered, "classical_candidates", lambda _w: [shaved])
        # 470x658 = only 1.04x classical's area — inside the 1.06 threshold.
        stub_birefnet(lambda work: _rect_mask(work.shape[:2], (265, 171, 735, 829)))

        result = tiered_crop(_jpeg(img))

        assert result is not None
        w, _h = _decode_size(result)
        assert w <= 480, "classical's crop should have been kept"

    def test_declines_when_nothing_passes_anywhere(self, stub_birefnet, monkeypatch):
        img = _canvas()
        monkeypatch.setattr(tiered, "classical_candidates", lambda _w: [])
        calls = stub_birefnet()  # zeros — BiRefNet finds nothing either

        assert tiered_crop(_jpeg(img)) is None
        assert len(calls) == 1


# ── BiRefNet plumbing (fake session — no downloads, no network) ─────────────


class TestBirefnetMask:
    def test_pads_with_measured_background_and_thresholds_alpha(self, monkeypatch):
        work = np.full((200, 300, 3), BG, np.uint8)
        work[60:140, 100:200] = CARD
        pad = int(tiered.BIREFNET_PAD * 300)  # 36
        seen: dict = {}

        def _fake_remove(arr, session=None):
            seen["shape"] = arr.shape
            seen["corner"] = tuple(int(v) for v in arr[0, 0])
            seen["session"] = session
            rgba = np.zeros((arr.shape[0], arr.shape[1], 4), np.uint8)
            # The card, in padded coordinates.
            rgba[60 + pad : 140 + pad, 100 + pad : 200 + pad, 3] = 255
            # Sub-threshold alpha elsewhere must NOT survive.
            rgba[pad : pad + 20, pad : pad + 20, 3] = 20
            return rgba

        fake_session = object()
        monkeypatch.setattr(tiered, "_session", fake_session)
        monkeypatch.setattr("rembg.remove", _fake_remove)

        mask = birefnet_mask(work)

        assert seen["shape"] == (200 + 2 * pad, 300 + 2 * pad, 3)
        # BORDER_CONSTANT padding uses the measured background color (RGB
        # order after the BGR→RGB conversion; gray is symmetric anyway).
        assert seen["corner"] == BG
        assert seen["session"] is fake_session
        assert mask.shape == (200, 300)
        assert mask[100, 150] == 255  # inside the card
        assert mask[10, 10] == 0  # alpha 20 ≤ 25 → background
        assert mask[190, 290] == 0

    def test_get_session_caches_and_reads_the_model_env(self, monkeypatch):
        created: list[str] = []
        sentinel = object()

        def _fake_new_session(model_name):
            created.append(model_name)
            return sentinel

        monkeypatch.setattr("rembg.new_session", _fake_new_session)
        monkeypatch.setenv("REMBG_MODEL", "birefnet-general-lite")

        assert _get_session() is sentinel
        assert _get_session() is sentinel
        assert created == ["birefnet-general-lite"]

    def test_get_session_rejects_models_outside_the_allowlist(self, monkeypatch):
        """rembg ships session classes that POST the image to third-party
        APIs (e.g. "withoutbg") — an env typo must fail loudly, never
        select one. The allowlist check runs before any session import."""
        monkeypatch.setenv("REMBG_MODEL", "withoutbg")

        with pytest.raises(ValueError, match="not allowed"):
            _get_session()

    def test_get_session_defaults_to_birefnet_general(self, monkeypatch):
        created: list[str] = []
        monkeypatch.setattr("rembg.new_session", lambda name: created.append(name) or object())
        monkeypatch.delenv("REMBG_MODEL", raising=False)

        _get_session()

        assert created == ["birefnet-general"]

    def test_unit_suite_refuses_real_session_creation(self):
        # The conftest guard: anything reaching the real loader fails loudly
        # instead of downloading ~1GB of weights in CI.
        with pytest.raises(AssertionError, match="must not create a real rembg session"):
            _get_session()
