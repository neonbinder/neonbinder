"""Unit tests for app.cropper.deskew.

The module's two interesting behaviours are both about *selection*, not
about the warp itself:

  1. It must pick the card, not the image border, when both are quads.
  2. It must DECLINE (return None) rather than warp when the best quad it
     can find is the image border — mirroring the Swift original's
     "no rectangle feature → pass the original through untouched".

Fixtures are rendered rather than checked in: a card rectangle on a
contrasting canvas, optionally rotated, which is enough to exercise corner
ordering, ranking and the frame decline. Assertions are on shape and
aspect, never pixel-exact, so OpenCV's interpolation and JPEG quantization
can't make them flaky.
"""

from __future__ import annotations

import io
import math

import numpy as np
import pytest
from PIL import Image

from app.cropper.deskew import (
    ASPECT_SIGNIFICANCE_BAND,
    DETECT_ASPECT_TOLERANCE,
    FRAME_AREA_FRACTION,
    MAX_OPPOSITE_SIDE_RATIO,
    MAX_OUTPUT_ASPECT_ERROR,
    MAX_UNSUPPORTED_EDGES,
    MIN_EDGE_SUPPORT_FRACTION,
    _card_aspect_error,
    _clamp_quad,
    _edge_support_fractions,
    _expand_quad,
    _finalize_quad,
    _opposite_side_ratio,
    _order_corners,
    _quad_is_trustworthy,
    _quad_side_lengths,
    _select_best_candidate,
    deskew_crop,
)
from app.cropper.validator import CARD_ASPECT_PORTRAIT

CARD_W, CARD_H = 500, 700  # 0.7143 — exactly card aspect


def _render(
    *,
    canvas: tuple[int, int] = (1200, 1500),
    quad: list[tuple[float, float]] | None = None,
    card_color: tuple[int, int, int] = (235, 235, 235),
    bg_color: tuple[int, int, int] = (12, 12, 12),
) -> bytes:
    """Render a filled quadrilateral (the card) on a solid canvas.

    Drawn with cv2.fillPoly rather than PIL so the edge OpenCV later has to
    find is the same kind of edge it sees in real images.
    """
    import cv2

    width, height = canvas
    img = np.full((height, width, 3), bg_color[::-1], dtype=np.uint8)
    if quad is None:
        left = (width - CARD_W) // 2
        top = (height - CARD_H) // 2
        quad = [
            (left, top),
            (left + CARD_W, top),
            (left + CARD_W, top + CARD_H),
            (left, top + CARD_H),
        ]
    cv2.fillPoly(img, [np.array(quad, dtype=np.int32)], card_color[::-1])
    # Faint interior texture — a perfectly flat card can read as
    # near-uniform, which is not what any real card looks like.
    cv2.rectangle(
        img,
        (int(quad[0][0]) + 40, int(quad[0][1]) + 60),
        (int(quad[2][0]) - 40, int(quad[2][1]) - 200),
        (90, 70, 60),
        -1,
    )
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
    assert ok
    return bytes(buf)


def _rotated_card_quad(canvas: tuple[int, int], degrees: float) -> list[tuple[float, float]]:
    """Corners of a centred card rotated by `degrees` about the canvas centre."""
    cx, cy = canvas[0] / 2, canvas[1] / 2
    half_w, half_h = CARD_W / 2, CARD_H / 2
    corners = [(-half_w, -half_h), (half_w, -half_h), (half_w, half_h), (-half_w, half_h)]
    theta = math.radians(degrees)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    return [(cx + x * cos_t - y * sin_t, cy + x * sin_t + y * cos_t) for x, y in corners]


def _size(image_bytes: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(image_bytes)) as img:
        return img.size


class TestOrderCorners:
    def test_returns_top_left_first_clockwise(self):
        # Deliberately scrambled input order.
        pts = np.array([[10, 90], [90, 10], [10, 10], [90, 90]], dtype=np.float32)
        ordered = _order_corners(pts)
        assert ordered.tolist() == [[10, 10], [90, 10], [90, 90], [10, 90]]

    def test_handles_rotation_past_45_degrees(self):
        """The sum/difference shortcut mislabels these; angle sorting doesn't."""
        pts = np.array([[50, 0], [100, 50], [50, 100], [0, 50]], dtype=np.float32)
        ordered = _order_corners(pts)
        # Whatever it calls "top-left", the four corners must come back in a
        # single non-self-intersecting cycle — the diagonals must cross.
        assert len(ordered) == 4
        centroid = ordered.mean(axis=0)
        assert np.allclose(centroid, [50, 50], atol=1.0)
        # Opposite corners (0,2) and (1,3) straddle the centroid.
        assert np.allclose((ordered[0] + ordered[2]) / 2, centroid, atol=1.0)
        assert np.allclose((ordered[1] + ordered[3]) / 2, centroid, atol=1.0)


class TestQuadGeometry:
    def test_side_lengths_take_the_longer_opposing_edge(self):
        quad = np.array([[0, 0], [100, 0], [80, 200], [0, 200]], dtype=np.float32)
        width, height = _quad_side_lengths(quad)
        assert width == pytest.approx(100.0)
        assert height == pytest.approx(200.99, abs=0.5)

    def test_aspect_error_is_zero_for_a_card_shaped_quad(self):
        assert _card_aspect_error(CARD_W, CARD_H) == pytest.approx(0.0, abs=1e-9)

    def test_aspect_error_matches_landscape_too(self):
        assert _card_aspect_error(CARD_H, CARD_W) == pytest.approx(0.0, abs=1e-9)

    def test_aspect_error_of_a_square_is_large(self):
        assert _card_aspect_error(500, 500) > DETECT_ASPECT_TOLERANCE

    def test_expand_quad_adds_a_uniform_margin_on_every_side(self):
        quad = np.array([[0, 0], [100, 0], [100, 100], [0, 100]], dtype=np.float32)
        grown = _expand_quad(quad, 5.0)
        assert np.allclose(grown.mean(axis=0), quad.mean(axis=0))
        assert np.allclose(grown, [[-5, -5], [105, -5], [105, 105], [-5, 105]], atol=1e-4)

    def test_expand_quad_margin_is_uniform_on_a_non_square_quad(self):
        """A portrait card must gain the same pixels on short and long sides.

        Scaling about the centroid would add 10x more to the 1000px sides
        than to the 100px ones; edge-normal offsetting adds 5px to each.
        """
        quad = np.array([[0, 0], [100, 0], [100, 1000], [0, 1000]], dtype=np.float32)
        grown = _expand_quad(quad, 5.0)
        assert grown[:, 0].max() - grown[:, 0].min() == pytest.approx(110.0)
        assert grown[:, 1].max() - grown[:, 1].min() == pytest.approx(1010.0)

    def test_expand_quad_is_a_noop_for_a_non_positive_margin(self):
        quad = np.array([[0, 0], [100, 0], [100, 100], [0, 100]], dtype=np.float32)
        assert np.allclose(_expand_quad(quad, 0.0), quad)

    def test_expand_quad_handles_a_rotated_quad(self):
        """A 45-degree diamond still gains the margin along its own normals."""
        quad = np.array([[50, 0], [100, 50], [50, 100], [0, 50]], dtype=np.float32)
        grown = _expand_quad(quad, 5.0)
        original_w, original_h = _quad_side_lengths(_order_corners(quad))
        grown_w, grown_h = _quad_side_lengths(_order_corners(grown))
        assert grown_w - original_w == pytest.approx(10.0, abs=0.5)
        assert grown_h - original_h == pytest.approx(10.0, abs=0.5)

    def test_clamp_quad_keeps_corners_inside_the_image(self):
        quad = np.array([[-20, -30], [1200, -5], [1200, 900], [-20, 900]], dtype=np.float32)
        clamped = _clamp_quad(quad, (1000, 800))
        assert clamped[:, 0].min() >= 0
        assert clamped[:, 1].min() >= 0
        assert clamped[:, 0].max() <= 999
        assert clamped[:, 1].max() <= 799


class TestDeskewHappyPath:
    def test_axis_aligned_card_is_found_and_warped_to_card_aspect(self):
        result = deskew_crop(_render())
        assert result is not None
        width, height = _size(result)
        assert _card_aspect_error(width, height) < 0.05

    @pytest.mark.parametrize("degrees", [8, 15, -12])
    def test_rotated_card_is_deskewed_back_to_card_aspect(self, degrees):
        """The point of the module: a tilted card comes out axis-aligned.

        An axis-aligned bounding box of a card tilted 15° is ~20% off card
        aspect; the perspective-corrected warp should be within a few
        percent.
        """
        canvas = (1200, 1500)
        result = deskew_crop(_render(canvas=canvas, quad=_rotated_card_quad(canvas, degrees)))
        assert result is not None
        width, height = _size(result)
        assert _card_aspect_error(width, height) <= MAX_OUTPUT_ASPECT_ERROR
        assert width / height == pytest.approx(CARD_ASPECT_PORTRAIT, rel=0.10)

    def test_output_is_full_resolution_not_detection_resolution(self):
        """Detection downscales to DETECT_MAX_SIDE_PX; the warp must not."""
        scale = 4
        canvas = (1200 * scale, 1500 * scale)
        quad = [
            (200 * scale, 250 * scale),
            ((200 + CARD_W) * scale, 250 * scale),
            ((200 + CARD_W) * scale, (250 + CARD_H) * scale),
            (200 * scale, (250 + CARD_H) * scale),
        ]
        result = deskew_crop(_render(canvas=canvas, quad=quad))
        assert result is not None
        width, height = _size(result)
        # Card is 2000x2800 in source pixels — comfortably over the 1000px
        # detection cap, which it could not be if we warped the small copy.
        assert width > 1500
        assert height > 2000


class TestDeskewDeclines:
    def test_returns_none_for_unreadable_bytes(self):
        assert deskew_crop(b"definitely not an image") is None

    def test_returns_none_for_empty_bytes(self):
        assert deskew_crop(b"") is None

    def test_returns_none_when_the_image_is_already_the_card(self):
        """An already-tight card scan has nothing to deskew.

        The only quad here is the image boundary, so the frame check fires
        and the stage declines — the cascade's pil_trim stages handle this
        case correctly and would be robbed of it otherwise.
        """
        import cv2

        img = np.full((1400, 1000, 3), (235, 235, 235), dtype=np.uint8)
        cv2.rectangle(img, (60, 90), (940, 1100), (90, 70, 60), -1)
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
        assert ok
        assert deskew_crop(bytes(buf)) is None

    def test_returns_none_when_nothing_is_card_shaped(self):
        """A wide bar on a plain canvas is not a card at any tolerance."""
        import cv2

        img = np.full((1000, 1000, 3), (12, 12, 12), dtype=np.uint8)
        cv2.rectangle(img, (100, 450), (900, 550), (235, 235, 235), -1)
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
        assert ok
        assert deskew_crop(bytes(buf)) is None

    def test_declining_never_raises_on_a_solid_image(self):
        import cv2

        img = np.full((800, 800, 3), (128, 128, 128), dtype=np.uint8)
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
        assert ok
        assert deskew_crop(bytes(buf)) is None


class TestRankingBeatsTheBorderTrap:
    def test_picks_the_card_over_the_image_border(self):
        """The border is the largest quad in every frame; it must still lose.

        The canvas here is 1000x1330 — 0.752, only ~5% off card aspect,
        matching a real 6144x8160 phone frame. Ranked by AREA the border
        wins outright; ranked by aspect error the card does.
        """
        canvas = (1000, 1330)
        result = deskew_crop(_render(canvas=canvas))
        assert result is not None
        width, height = _size(result)
        assert width < canvas[0] * FRAME_AREA_FRACTION
        assert _card_aspect_error(width, height) < 0.05

    def test_band_constant_stays_inside_its_measured_window(self):
        """Guard rail for the one knob with a genuinely narrow safe range.

        The corpus pins this to (1.0pp, 1.96pp): below the lower bound an
        inner panel beats the card outline on 2026-08-11-0015; above the
        upper bound deskew declines on PXL_20250320_005433897 and the
        cascade ships the whole photo instead of a crop.
        """
        assert 0.010 < ASPECT_SIGNIFICANCE_BAND < 0.0196


class TestQuadIntegrityGate:
    """The check that aspect error structurally cannot make.

    A quad landing INSIDE the card is still card-shaped, so it warps to a
    clean 0.714 and `MAX_OUTPUT_ASPECT_ERROR` never fires. Human review of
    the 2026-08-14 sample set caught two such crops shipping clipped at
    2.2% and 3.0%. These tests pin the two signals that do catch them.
    """

    CANVAS = (600, 800)
    # left, top, width, height — 200/280 is exactly card aspect, and the
    # card is centred so every edge has real background outside it. An
    # edge flush against the frame would report no support simply because
    # its samples fall off the image.
    CARD = (200, 260, 200, 280)

    def _gray(self, *, break_edges: int = 0) -> np.ndarray:
        """A bright card on a dark field, with `break_edges` edges erased.

        An edge is 'erased' by filling the background just outside it with
        the card's own value, so no gradient survives there — which is what
        a clear slab bevel against black foam looks like to Sobel.
        """
        import cv2

        left, top, width, height = self.CARD
        gray = np.full((self.CANVAS[1], self.CANVAS[0]), 20, dtype=np.uint8)
        cv2.rectangle(gray, (left, top), (left + width, top + height), 230, -1)
        # Interior texture so the card isn't a flat plane. Kept as a blob
        # well clear of the inset quads below — a texture edge running
        # along one of them would lend it exactly the support these tests
        # are checking it does not have.
        cv2.circle(gray, (left + width // 2, top + height // 2), 30, 120, -1)

        pad = 12
        if break_edges >= 1:  # top
            gray[top - pad : top, left : left + width] = 230
        if break_edges >= 2:  # bottom
            gray[top + height : top + height + pad, left : left + width] = 230
        if break_edges >= 3:  # left
            gray[top : top + height, left - pad : left] = 230
        return gray

    def _outline(self) -> np.ndarray:
        left, top, width, height = self.CARD
        return np.array(
            [[left, top], [left + width, top], [left + width, top + height], [left, top + height]],
            dtype=np.float32,
        )

    def _inset(self, inset_px: int) -> np.ndarray:
        left, top, width, height = self.CARD
        return np.array(
            [
                [left + inset_px, top + inset_px],
                [left + width - inset_px, top + inset_px],
                [left + width - inset_px, top + height - inset_px],
                [left + inset_px, top + height - inset_px],
            ],
            dtype=np.float32,
        )

    # ── opposite-side ratio ────────────────────────────────────────────
    def test_ratio_of_a_rectangle_is_one(self):
        assert _opposite_side_ratio(self._outline()) == pytest.approx(1.0, abs=1e-4)

    def test_ratio_grows_with_trapezoid_skew(self):
        """2026-08-12-0016's mis-detect measured 1.34 on a flatbed scan."""
        quad = np.array([[0, 0], [400, 0], [300, 560], [100, 560]], dtype=np.float32)
        assert _opposite_side_ratio(quad) == pytest.approx(2.0, abs=0.01)

    def test_ratio_of_a_degenerate_quad_is_infinite(self):
        quad = np.array([[0, 0], [0, 0], [300, 400], [0, 400]], dtype=np.float32)
        assert _opposite_side_ratio(quad) == float("inf")

    # ── edge support ───────────────────────────────────────────────────
    def test_the_real_outline_is_supported_on_every_edge(self):
        supports = _edge_support_fractions(self._gray(), self._outline())
        assert len(supports) == 4
        assert min(supports) >= MIN_EDGE_SUPPORT_FRACTION

    def test_a_quad_inside_the_card_loses_support(self):
        """The clipping failure mode: no card boundary under these edges."""
        supports = _edge_support_fractions(self._gray(), self._inset(40))
        assert sum(1 for s in supports if s < MIN_EDGE_SUPPORT_FRACTION) > MAX_UNSUPPORTED_EDGES

    def test_a_zero_length_edge_reports_no_support(self):
        quad = np.array([[100, 100], [100, 100], [400, 500], [100, 500]], dtype=np.float32)
        assert _edge_support_fractions(self._gray(), quad)[0] == 0.0

    # ── the gate itself ────────────────────────────────────────────────
    def test_trusts_the_cards_real_outline(self):
        assert _quad_is_trustworthy(self._gray(), self._outline()) is True

    def test_tolerates_a_single_unsupported_edge(self):
        """One low-contrast side is normal and must not be fatal.

        A card whose edge abuts a similarly-toned background genuinely has
        no gradient there. Only the SECOND weak edge is evidence that the
        quad is not tracing a boundary at all.
        """
        assert _quad_is_trustworthy(self._gray(break_edges=1), self._outline()) is True

    def test_declines_once_two_edges_are_unsupported(self):
        assert _quad_is_trustworthy(self._gray(break_edges=2), self._outline()) is False

    def test_declines_a_quad_inside_the_card(self):
        assert _quad_is_trustworthy(self._gray(), self._inset(40)) is False

    def test_declines_an_implausibly_skewed_quad_even_with_strong_edges(self):
        """0016's quad partly follows the real outline, so support clears it.

        The side-ratio check is the only thing that catches this one.
        """
        import cv2

        gray = self._gray()
        skewed = np.array([[150, 150], [450, 150], [400, 600], [200, 600]], dtype=np.float32)
        cv2.polylines(gray, [skewed.astype(np.int32)], True, 230, 3)
        assert _opposite_side_ratio(skewed) > MAX_OPPOSITE_SIDE_RATIO
        assert _quad_is_trustworthy(gray, skewed) is False

    # ── threshold guard rails ──────────────────────────────────────────
    def test_thresholds_stay_inside_their_measured_separation(self):
        """Both constants sit in an empty band; a nudge should fail loudly.

        Measured on the ORIGINAL 227-image corpus: every retained deskew
        win scores 85.9-100% on all four edges with an opposing-side ratio
        <=1.02, while the rejects carry edges at 0-52% and ratios of
        1.35-1.55. Dropping the support bar to 0.55 to rescue the one
        marginal slab would leave 1.2pp against a confirmed clipper.
        """
        assert 0.55 < MIN_EDGE_SUPPORT_FRACTION < 0.86
        assert 1.02 < MAX_OPPOSITE_SIDE_RATIO < 1.35
        # Discrete, not tuned: the slab needs 1, the clippers had 2 and 3.
        assert MAX_UNSUPPORTED_EDGES == 1


class TestSelectBestCandidate:
    """The ranking policy on its own, without OpenCV in the way.

    Each case is a real situation from the corpus, reduced to the
    `(aspect_error, area_fraction, quad)` triples the detector produces.
    """

    @staticmethod
    def _quad(tag: float) -> np.ndarray:
        """A distinguishable placeholder quad — selection never inspects it."""
        return np.full((4, 2), tag, dtype=np.float32)

    def test_lowest_aspect_error_wins_when_the_gap_is_decisive(self):
        """The phone-photo case: card 0.8% vs image frame 5.4%.

        Ranked by area the frame wins every time; ranked by aspect the card
        does, and the gap here (4.6pp) is far outside the band.
        """
        card = (0.008, 0.63, self._quad(1))
        frame = (0.054, 1.00, self._quad(2))
        best = _select_best_candidate([frame, card])
        assert best is not None
        assert best[0] == pytest.approx(0.008)

    def test_outer_quad_wins_when_the_inner_one_is_only_marginally_better(self):
        """2026-08-11-0015: inner photo window 0.2% vs card outline 1.2%.

        The inner rectangle has the better aspect but by less than the
        band, so the outer one takes it. Selecting the inner quad here cost
        the card's entire name/position band.
        """
        inner = (0.002, 0.83, self._quad(1))
        outer = (0.012, 0.99, self._quad(2))
        best = _select_best_candidate([inner, outer])
        assert best is None, "frame-sized outer quad should trigger the decline"

    def test_inner_quad_still_loses_to_a_non_frame_outer_quad(self):
        """Same near-tie, but the outer quad is a real sub-frame crop."""
        inner = (0.002, 0.50, self._quad(1))
        outer = (0.012, 0.80, self._quad(2))
        best = _select_best_candidate([inner, outer])
        assert best is not None
        assert best[1] == pytest.approx(0.80)

    def test_declines_when_the_winner_is_the_image_frame(self):
        """An already-tight scan: the only card-shaped quad is the frame."""
        assert _select_best_candidate([(0.002, 0.995, self._quad(1))]) is None

    def test_returns_none_for_no_candidates(self):
        assert _select_best_candidate([]) is None

    def test_a_decisively_better_small_quad_still_wins(self):
        """The band is a tie-breaker, not a bias toward size."""
        small = (0.005, 0.20, self._quad(1))
        large = (0.100, 0.85, self._quad(2))
        best = _select_best_candidate([small, large])
        assert best is not None
        assert best[1] == pytest.approx(0.20)


class TestFailureHandling:
    """Every failure path must return None, never raise.

    A cropper that raises takes out the whole cascade — the /crop endpoint
    reports it as a crash and `crop()` loses the stage entirely — so each
    of these is a real guarantee, not defensive noise.
    """

    def test_undecodable_image_returns_none(self, monkeypatch):
        monkeypatch.setattr("cv2.imdecode", lambda *_a, **_k: None)
        assert deskew_crop(_render()) is None

    def test_decode_raising_returns_none(self, monkeypatch):
        def _boom(*_args, **_kwargs):
            raise RuntimeError("decode exploded")

        monkeypatch.setattr("cv2.imdecode", _boom)
        assert deskew_crop(_render()) is None

    def test_quad_detection_raising_returns_none(self, monkeypatch):
        def _boom(_bgr):
            raise RuntimeError("detection exploded")

        monkeypatch.setattr("app.cropper.deskew._find_card_quad", _boom)
        assert deskew_crop(_render()) is None

    def test_warp_raising_returns_none(self, monkeypatch):
        def _boom(_bgr, _quad):
            raise RuntimeError("warp exploded")

        monkeypatch.setattr("app.cropper.deskew._warp", _boom)
        assert deskew_crop(_render()) is None

    def test_warp_returning_none_returns_none(self, monkeypatch):
        monkeypatch.setattr("app.cropper.deskew._warp", lambda _bgr, _quad: None)
        assert deskew_crop(_render()) is None

    def test_encode_failure_returns_none(self, monkeypatch):
        # Render before patching — the fixture itself encodes a JPEG.
        image_bytes = _render()
        monkeypatch.setattr("cv2.imencode", lambda *_a, **_k: (False, None))
        assert deskew_crop(image_bytes) is None

    def test_degenerate_quad_produces_no_warp(self):
        """A zero-area quad has no output rectangle to warp into."""
        from app.cropper.deskew import _warp

        bgr = np.zeros((100, 100, 3), dtype=np.uint8)
        degenerate = np.zeros((4, 2), dtype=np.float32)
        assert _warp(bgr, degenerate) is None

    def test_aspect_error_of_zero_height_is_infinite(self):
        assert _card_aspect_error(100, 0) == float("inf")


class TestFinalizeQuadDeclines:
    """The plausibility gate — deskew's last chance to not ship a bad crop.

    A warped output far off card aspect means the quad was mis-detected,
    almost always with a corner inside the card. That crops the card down,
    and because these print full-bleed to the cut line (NEO-152) a clipped
    logo is unrecoverable: the knife can remove background, but it cannot
    put a logo back. So the gate declines and the cascade continues.
    """

    IMAGE_SIZE = (4000, 6000)

    @staticmethod
    def _rect(width: float, height: float, origin: tuple[float, float] = (500, 500)):
        left, top = origin
        return np.array(
            [
                [left, top],
                [left + width, top],
                [left + width, top + height],
                [left, top + height],
            ],
            dtype=np.float32,
        )

    def test_accepts_a_card_shaped_quad(self):
        result = _finalize_quad(self._rect(2000, 2800), self.IMAGE_SIZE)
        assert result is not None
        _quad, out_w, out_h = result
        assert _card_aspect_error(out_w, out_h) <= MAX_OUTPUT_ASPECT_ERROR

    def test_accepts_a_landscape_card(self):
        result = _finalize_quad(self._rect(2800, 2000), self.IMAGE_SIZE)
        assert result is not None

    def test_declines_a_quad_that_clipped_the_cards_height(self):
        """2026-08-12-0022's shape: too wide, i.e. vertical extent lost.

        Aspect 0.759 against the card's 0.714 — the "ZENITH" logo was cut
        off the top edge. The margin cannot rescue this (a uniform margin
        pulls the ratio toward 1.0, making it worse), so it must decline.
        """
        assert _finalize_quad(self._rect(2000, 2635), self.IMAGE_SIZE) is None

    def test_declines_a_clipped_landscape_card(self):
        """PXL_20250709_131656226's shape: 1.549 against landscape's 1.400."""
        assert _finalize_quad(self._rect(3099, 2000), self.IMAGE_SIZE) is None

    def test_applies_the_margin_so_output_exceeds_the_detected_quad(self):
        """The margin must actually reach the output, not just the quad."""
        result = _finalize_quad(self._rect(2000, 2800), self.IMAGE_SIZE)
        assert result is not None
        _quad, out_w, out_h = result
        assert out_w > 2000
        assert out_h > 2800

    def test_margin_is_uniform_in_pixels_across_both_axes(self):
        result = _finalize_quad(self._rect(2000, 2800), self.IMAGE_SIZE)
        assert result is not None
        _quad, out_w, out_h = result
        assert (out_w - 2000) == pytest.approx(out_h - 2800, abs=1)

    def test_declines_a_degenerate_quad(self):
        assert _finalize_quad(np.zeros((4, 2), dtype=np.float32), self.IMAGE_SIZE) is None

    def test_output_stays_inside_the_image(self):
        """A card hard against the frame edge must not warp from outside it."""
        result = _finalize_quad(self._rect(2000, 2800, origin=(0, 0)), self.IMAGE_SIZE)
        assert result is not None
        quad, _out_w, _out_h = result
        assert quad[:, 0].min() >= 0
        assert quad[:, 1].min() >= 0
        assert quad[:, 0].max() <= self.IMAGE_SIZE[0] - 1
        assert quad[:, 1].max() <= self.IMAGE_SIZE[1] - 1
