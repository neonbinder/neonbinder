"""Perspective-correcting deskew — port of script-frontend's CardCropper.rotate.swift.

The Swift original is 63 lines of CoreImage: run `CIDetectorTypeRectangle`
at `CIDetectorAccuracyHigh`, take the *first* rectangle feature, feed its
four corners to `CIPerspectiveCorrection`, write the result. If no
rectangle is found it copies the original through untouched. That
fall-through is load-bearing — the caller always gets a usable file — and
this port preserves it by returning None so the cascade continues to the
next strategy.

`CIDetector` is Apple Vision and cannot run on Cloud Run, so the detection
half is rebuilt on OpenCV (already a dependency via SAM; this module adds
no new runtime dep). The pipeline is the standard document-scanner one:

    threshold / edge  →  findContours  →  approxPolyDP to a convex quad
                      →  order corners →  getPerspectiveTransform
                      →  warpPerspective

**Why this exists at all.** `pil_trim` takes an axis-aligned bounding box.
On a card photographed at an angle — the normal case for a phone held over
a desk — the tight axis-aligned box around a tilted card necessarily
contains background wedges at all four corners, and its aspect ratio is
wrong by the tilt. Deskewing unwarps the card into a true rectangle, so a
handheld photo comes out looking like a scan.

**Ranking is by aspect error, never by area.** This is the one trap in the
whole approach and it is not subtle: the image border is itself a perfect
quad, it is always the largest quad in the frame, and any area-ranked
search picks it every single time. Measured on a real phone photo:

    Canny mask      508x717   aspect 0.708   card-aspect err  0.8%   ← the card
    Otsu-inverted   751x999   aspect 0.752   card-aspect err  5.2%   ← the border

The border loses on aspect and wins on area, so aspect has to lead.

Two refinements make that survive the whole corpus rather than just the
phone photos, and each is a constant below with its measurement:

  - `ASPECT_SIGNIFICANCE_BAND` — aspect leads, but only decisively. Among
    candidates within a band of the best error, the OUTERMOST wins.
    Otherwise an inner rectangle — a card's photo window, a stats panel —
    beats the card outline by a fraction of a percent and the crop eats
    the card.
  - `FRAME_AREA_FRACTION` — if the winner turns out to BE the image
    boundary, deskew declines instead of warping it. On an already-tight
    scan (170 of the 227 corpus images) that is the honest answer: there
    is no perspective to correct, and pil_trim handles it downstream.

**Being card-shaped is not the same as being the card.** Ranking finds the
most card-like quad in the frame; it cannot tell whether that quad traces
the card's actual outline. A quad sitting INSIDE the card is still
card-shaped, warps to a clean 0.714, and so passes every aspect-based
check — which is exactly how this module shipped clipped cards at 2.2% and
3.0% output aspect error until human review caught them. The
quad-integrity gate (`_quad_is_trustworthy`, and the constants block that
documents it) is the separate line of evidence that closes that hole:
edges must lie on real intensity discontinuities, and the quad must be
shaped like a photographed rectangle.

Public API: `deskew_crop(image_bytes) -> bytes | None`.
"""

from __future__ import annotations

import logging

import numpy as np

from app.cropper.validator import CARD_ASPECT_LANDSCAPE, CARD_ASPECT_PORTRAIT

logger = logging.getLogger(__name__)

# Detect on a copy no larger than this on the longest edge, then warp the
# full-resolution original — the same detect-small / map-back pattern
# `sam._open_and_resize` and `pil_trim._open_and_resize` use. 1000px is
# enough for approxPolyDP to resolve card corners and keeps detection at
# ~300ms on a 50MP phone photo (20-90ms scanner-sized).
DETECT_MAX_SIDE_PX = 1000

# Gaussian blur kernel applied before edge/threshold. Smooths JPEG
# artifacts and scanner noise so Canny doesn't fragment the card edge into
# a contour that approxPolyDP can't close into a quad.
BLUR_KERNEL = (5, 5)

# Canny hysteresis thresholds. 30/120 is deliberately low: card edges
# against a dark scanner bed or a wood desk are low-contrast, and a missed
# edge costs a whole detection while a spurious one is filtered out later
# by the aspect gate.
CANNY_LOW = 30
CANNY_HIGH = 120

# Morphological close after Canny, to bridge the small gaps a card edge
# picks up where it crosses a similarly-coloured background patch. 7px at
# 1000px detection width is about the widest gap seen in the corpus.
CLOSE_KERNEL_PX = 7

# Only the largest few contours per mask are worth approximating — beyond
# that they're text, logos and scanner noise, none of which is card-sized.
MAX_CONTOURS_PER_MASK = 6

# approxPolyDP epsilons, as a fraction of contour perimeter, tried in
# order. 0.02 is the textbook value and resolves a clean card outline;
# 0.03/0.05 rescue edges made ragged by shadow or foil glare, at the cost
# of cutting corners on a genuinely non-quad contour (which then fails the
# aspect gate anyway).
APPROX_EPSILON_FRACTIONS = (0.02, 0.03, 0.05)

# A quad must cover at least this fraction of the frame. Below it, we're
# looking at a logo, a sticker or a block of text, not a card.
MIN_QUAD_AREA_FRACTION = 0.03

# A winning quad at or above this fraction of the frame IS the image
# boundary, and deskew declines (returns None) rather than warping it.
#
# Note what this is NOT: the frame is not filtered out of the ranking. It
# competes on aspect like every other candidate, and only a *win* by the
# frame causes the decline. That distinction is the whole design:
#
#   - Filtering the frame out early looks right on a phone photo but is
#     catastrophic on an already-tight card scan (the 992x1386 archives,
#     170 of the 227 corpus images). There the card outline IS the frame,
#     so removing it hands the win to the largest *inner* quad — measured,
#     that meant shaving the white border off the card on the fronts, and
#     on 2026-08-11-0104 cropping a card back down to its inner stats
#     panel, losing the card number entirely.
#   - Letting the frame compete and then declining when it wins means
#     "this image is already the card, there is nothing to deskew" — the
#     cascade moves on to pil_trim, which handles that case correctly.
#
# 0.92 sits above every genuine sub-frame card quad measured on the corpus
# and below the frame quad on every image where one was detected.
FRAME_AREA_FRACTION = 0.92

# Detection-time aspect tolerance, as a relative error against the nearer
# of the two card aspects. Tighter than `validator.ASPECT_TOLERANCE` (0.15)
# because we measure the *quad's* own side ratio, not a bounding box: a
# genuine card outline is already near card-aspect however badly the card
# is tilted, so a loose tolerance only admits junk. Measured on the corpus,
# relaxing 0.12 → 0.15 bought no additional correct crops and cost four
# regressions (a 578x364 fragment beating a clean scanner trim among them).
DETECT_ASPECT_TOLERANCE = 0.12

# Two candidate quads whose aspect errors differ by less than this are
# treated as equally card-shaped, and the LARGER (outermost) one wins.
#
# Without the band, an inner rectangle whose aspect beats the card's by a
# hair takes the crop. Measured on 2026-08-11-0015: the card's own photo
# window scored 0.2% against the card outline's 1.2%, won by that 1.0pp,
# and the crop lost the entire name/position band along the card's bottom
# edge. With the band, the outline wins, deskew sees a frame-sized winner
# and declines — correct, that scan is already the card.
#
# The band must also stay BELOW the margin by which a real card outline
# beats the image frame on a phone photo, or deskew declines on exactly the
# images it exists for. That margin is smaller than it looks: on
# PXL_20250320_005433897 the card scores 3.4% against the 6144x8160
# frame's 5.4%, a gap of 1.96pp.
#
# So the corpus pins this to the window (1.0pp, 1.96pp) and 1.5pp sits
# near its centre. It is a genuinely narrow window — if new imagery moves
# either bound, re-measure rather than nudging this by feel.
ASPECT_SIGNIFICANCE_BAND = 0.015

# Minimum warped side, in detection-space pixels, below which the quad is
# degenerate (a sliver from a partially-closed contour).
MIN_WARPED_SIDE_PX = 20

# ── Quad-integrity gate ────────────────────────────────────────────────────
#
# `MAX_OUTPUT_ASPECT_ERROR` below is necessary but NOT sufficient, and the
# gap between those two is what this section closes. Human review of the
# 2026-08-14 sample set found deskew shipping visibly clipped cards at 2.2%
# and 3.0% output aspect error — comfortably inside the 5% gate.
#
# The reason is structural: a quad that lands INSIDE the card is still
# card-shaped, so it warps to a clean 0.714 and the aspect gate sees
# nothing wrong. Aspect error detects a SKEWED quad; it is blind to an
# INSET one. So integrity has to be judged on evidence the aspect ratio
# cannot carry, and these two constants carry it:
#
#   1. Do the quad's edges actually lie on image edges? A real card
#      boundary is a strong, continuous intensity discontinuity along its
#      whole length. An edge invented inside the card crosses artwork and
#      only intermittently lands on a gradient.
#   2. Is the quad shaped like a photographed rectangle at all?
#
# All figures below are measured on the ORIGINAL corpus files. Re-encoded
# copies shift per-edge support by 3-5pp — enough to flip a marginal image
# — so re-measure against the originals, never against review renders.

# An edge counts as "supported" when at least this fraction of samples
# along it sit on a strong gradient.
#
# Measured over the 227-image corpus, every quad deskew still wins with
# scores 85.9-100% on ALL FOUR edges; its ratio-based twin below is
# equally lopsided. The rejects carry edges down at 0-52%. 0.60 sits in a
# 25.9pp-wide empty band, so this is a coarse threshold on a bimodal
# signal rather than a tuned one.
MIN_EDGE_SUPPORT_FRACTION = 0.60

# How many unsupported edges a quad may still be trusted with.
#
# One weak edge has to stay survivable — a single low-contrast side is
# normal (a clear slab bevel against black foam has no gradient at all) —
# while every confirmed clipper had two or more. Discrete separation, so
# this is exact rather than tuned: allow one, decline at two.
MAX_UNSUPPORTED_EDGES = 1

# Maximum ratio between opposing sides of the quad before it is refused.
#
# Perspective legitimately foreshortens the far edge of a card, so some
# inequality is expected and this cannot be tight. But 2026-08-12-0016 is
# a FLATBED SCAN, where perspective is physically impossible, and its
# mis-detected quad had opposing sides differing by 35% (with a 21.9°
# corner deviation to match). Every retained win measures ≤1.02; the
# rejects run 1.35, 1.40, 1.55. 1.25 sits in that gap.
#
# This is the check that catches a mis-detection whose edges DO have
# gradient support — 0016's quad partially follows the real card outline,
# so the support test alone clears it (its weakest edge is 59.4%, only
# just under the bar, and only one edge is weak).
MAX_OPPOSITE_SIDE_RATIO = 1.25

# What the gate costs, stated plainly so it is not rediscovered later:
# deskew's corpus wins drop 34 -> 28. Five of those six are quads with
# almost no edge support that were cropping into the card; the sixth,
# PXL_20250320_005433897, is a graded slab the reviewer called a good
# crop, and it is a genuine loss — its bevel gives it edges at 26.6% and
# 56.2%, the only marginal case in the corpus. It falls back to
# pil_trim_dark returning ~96% of the frame.
#
# Losing it is the deliberate call: the whole cascade prints full-bleed to
# the cut line (NEO-152), so shipping too much frame is recoverable with a
# knife and shipping a clipped card is not. A threshold low enough to keep
# the slab (0.55) would leave only a 1.2pp margin against a confirmed
# clipper at 51.6% — fitting noise, not measuring a boundary.

# Sampling geometry for the edge-support test, in detection-space pixels.
# 64 samples resolves a patchy edge without making the test expensive
# (~2ms/quad); the perpendicular search absorbs the corner quantization
# that detecting at ≤1000px introduces.
EDGE_SUPPORT_SAMPLES = 64
EDGE_SUPPORT_PERP_PX = 3

# "Strong gradient" is defined relative to the image rather than as an
# absolute intensity, so the test behaves the same on a flat scanner bed
# and a noisy hand-held photo. The 90th percentile keeps roughly the top
# tenth of gradient magnitudes, which is where real card edges live.
EDGE_SUPPORT_GRADIENT_PERCENTILE = 90

# Absolute floor under that percentile — without it the gate fails OPEN.
#
# On a near-uniform frame more than 90% of pixels have zero gradient, so
# the percentile itself lands at ~0, every sample clears it, and all four
# edges report full support no matter where the quad sits. That is the
# worst possible failure direction for a safety check.
#
# Measured across 117 corpus images the 90th percentile runs 12.2 to
# 229.0 (median 129.6), so a floor of 10 sits below every real image and
# never binds in practice; it exists purely to stop the relative
# threshold collapsing on degenerate input.
EDGE_SUPPORT_MIN_GRADIENT = 10.0

# Dilate the detected quad outward by this fraction of its SHORTER side
# before warping — a uniform pixel margin on all four edges, not a scale
# about the centroid (see `_expand_quad`).
#
# The asymmetry that justifies it: these crops print full-bleed to the cut
# line (NEO-152), so the knife removes a sliver of background for free, but
# nothing can restore a logo the warp already cut off. Erring outward is
# therefore strictly cheaper than erring inward. Detection also runs at
# ≤1000px, so one detection pixel is up to ~8 original pixels on a 50MP
# photo and the corners carry real quantization error.
#
# Chosen by measurement, not by copying the Swift: that file declares
# `let padding: CGFloat = 30` at the top and never uses it.
#
# The margin is not free, and the cost is measurable. A uniform margin adds
# the same pixels to both axes, so it pulls the output ratio toward 1.0 and
# makes a portrait card's aspect error WORSE. Swept over the corpus, median
# aspect error across deskew's wins runs 0.97% / 1.24% / 1.51% / 2.05% /
# 2.47% at 0 / 0.5 / 1 / 2 / 3%. So the margin trades measured aspect
# fidelity for clipping insurance, and 1% buys the insurance while leaving
# the median error (1.51%) a long way clear of MAX_OUTPUT_ASPECT_ERROR.
# In absolute terms that is ~10px on a 1000px-wide card and ~47px on a
# 4700px one — enough to cover corner quantization, small enough that it
# cannot reintroduce the background wedges deskew exists to remove.
QUAD_MARGIN_FRACTION = 0.01

# Ship nothing whose warped output is further than this from card aspect.
#
# A large post-warp aspect error is EVIDENCE THE QUAD WAS MIS-DETECTED —
# most often a corner landed inside the card, so the warp cut the card
# down. That is the one failure mode worth being strict about, because a
# clipped card is not recoverable downstream: it prints full-bleed with the
# logo already gone. Declining instead hands the image to the next cascade
# stage, which is exactly the Swift original's "no rectangle found → pass
# the file through" semantic applied one step later.
#
# The corpus separates cleanly here. Sorted by output aspect error,
# deskew's wins run 9.98 / 8.08 / 6.87 / 6.81 / 5.64 | 3.18 / 2.78 / ...
# — a 2.46pp gap with nothing in it, and 5% sits inside that gap. Above the
# gap sit both known clippers: 2026-08-12-0022 (the "ZENITH" logo cut off
# the top edge) and PXL_20250709_131656226 (a landscape card losing
# "FRYAR" off the right). Below it, every win is a complete card.
#
# This costs deskew 5 of 39 wins, two of which (2026-08-11-0151 and -0165)
# looked fine by eye. That is the intended trade: the fallback for both is
# pil_trim_dark at 0.7% and 1.6% error, so nothing is lost, and a rule that
# only ships what it is confident about is worth more than five extra wins.
MAX_OUTPUT_ASPECT_ERROR = 0.05

OUTPUT_JPEG_QUALITY = 92


def _order_corners(pts: np.ndarray) -> np.ndarray:
    """Order four points as top-left, top-right, bottom-right, bottom-left.

    Sorts by angle around the centroid rather than by the usual
    sum/difference trick, which mislabels corners once a card is rotated
    much past 45°. In image coordinates (y increasing downward) ascending
    `atan2` walks the quad clockwise, so rolling the sequence to start at
    the corner nearest the origin yields TL, TR, BR, BL.
    """
    pts = pts.reshape(4, 2).astype(np.float32)
    centroid = pts.mean(axis=0)
    angles = np.arctan2(pts[:, 1] - centroid[1], pts[:, 0] - centroid[0])
    clockwise = pts[np.argsort(angles)]
    top_left_index = int(np.argmin(clockwise.sum(axis=1)))
    return np.roll(clockwise, -top_left_index, axis=0).astype(np.float32)


def _line_intersection(
    a0: np.ndarray, a1: np.ndarray, b0: np.ndarray, b1: np.ndarray
) -> np.ndarray | None:
    """Intersection of the infinite lines a0→a1 and b0→b1, or None if parallel."""
    da = a1 - a0
    db = b1 - b0
    denominator = float(da[0] * db[1] - da[1] * db[0])
    if abs(denominator) < 1e-9:
        return None
    offset = b0 - a0
    t = float(offset[0] * db[1] - offset[1] * db[0]) / denominator
    return (a0 + da * t).astype(np.float32)


def _expand_quad(quad: np.ndarray, margin_px: float) -> np.ndarray:
    """Dilate the quad outward by a uniform `margin_px` on all four sides.

    Each edge is pushed out along its own outward normal and the new
    corners are the intersections of adjacent pushed edges. That keeps the
    margin uniform in pixels whatever the quad's shape or rotation — unlike
    scaling about the centroid, which grows each axis in proportion to its
    own length and so pads a portrait card's long sides much more than its
    short ones.

    Returns the quad unchanged if the margin is non-positive or the
    geometry degenerates (parallel adjacent edges).
    """
    if margin_px <= 0:
        return quad

    centroid = quad.mean(axis=0)
    pushed: list[tuple[np.ndarray, np.ndarray]] = []
    for index in range(4):
        start = quad[index]
        end = quad[(index + 1) % 4]
        direction = end - start
        normal = np.array([-direction[1], direction[0]], dtype=np.float32)
        length = float(np.linalg.norm(normal))
        if length < 1e-9:
            return quad
        normal /= length
        # Point the normal away from the quad's interior.
        if float(np.dot(normal, start - centroid)) < 0:
            normal = -normal
        shift = normal * margin_px
        pushed.append((start + shift, end + shift))

    expanded = []
    for index in range(4):
        previous_edge = pushed[(index - 1) % 4]
        current_edge = pushed[index]
        corner = _line_intersection(*previous_edge, *current_edge)
        if corner is None:
            return quad
        expanded.append(corner)
    return np.array(expanded, dtype=np.float32)


def _clamp_quad(quad: np.ndarray, image_size: tuple[int, int]) -> np.ndarray:
    """Clamp every corner inside the image.

    Expansion can push a corner off the edge when the card was already
    hard against it. warpPerspective would replicate border pixels there,
    which is a smear rather than an error, but clamping keeps the output
    honest about what was actually photographed.
    """
    width, height = image_size
    clamped = quad.copy()
    clamped[:, 0] = np.clip(clamped[:, 0], 0, width - 1)
    clamped[:, 1] = np.clip(clamped[:, 1], 0, height - 1)
    return clamped.astype(np.float32)


def _quad_side_lengths(quad: np.ndarray) -> tuple[float, float]:
    """Return (width, height) of an ordered TL/TR/BR/BL quad.

    Each dimension takes the longer of the two opposing edges, so a
    perspective-foreshortened near edge doesn't shrink the output.
    """
    top_left, top_right, bottom_right, bottom_left = quad
    width = max(
        float(np.linalg.norm(bottom_right - bottom_left)),
        float(np.linalg.norm(top_right - top_left)),
    )
    height = max(
        float(np.linalg.norm(top_right - bottom_right)),
        float(np.linalg.norm(top_left - bottom_left)),
    )
    return width, height


def _card_aspect_error(width: float, height: float) -> float:
    """Relative error of width/height against the nearer standard card aspect."""
    if height <= 0:
        return float("inf")
    ratio = width / height
    return min(
        abs(ratio - CARD_ASPECT_PORTRAIT) / CARD_ASPECT_PORTRAIT,
        abs(ratio - CARD_ASPECT_LANDSCAPE) / CARD_ASPECT_LANDSCAPE,
    )


def _opposite_side_ratio(quad: np.ndarray) -> float:
    """Ratio of the longer to the shorter of each opposing side pair, worst case.

    1.0 is a perfect parallelogram. Perspective pushes it up legitimately —
    the far edge of a tilted card really is shorter — so this only ever
    catches gross mis-detection. Returns inf for a degenerate quad.
    """
    sides = [float(np.linalg.norm(quad[(index + 1) % 4] - quad[index])) for index in range(4)]
    worst = 1.0
    for first, second in ((sides[0], sides[2]), (sides[1], sides[3])):
        shorter, longer = min(first, second), max(first, second)
        if shorter <= 1e-9:
            return float("inf")
        worst = max(worst, longer / shorter)
    return worst


def _edge_support_fractions(gray: np.ndarray, quad: np.ndarray) -> list[float]:
    """For each quad edge, the fraction of its length lying on a strong gradient.

    `quad` must be in DETECTION space, matching `gray`. Samples run along
    each edge and, at every sample, search `EDGE_SUPPORT_PERP_PX` either
    side perpendicular for the strongest gradient — the perpendicular
    search is what absorbs corner quantization from detecting at ≤1000px.

    Samples falling outside the image contribute no support rather than
    being clamped to the border, so a quad edge running off-frame is
    honestly reported as unsupported instead of borrowing the edge pixel's
    gradient.
    """
    import cv2

    blurred = cv2.GaussianBlur(gray, BLUR_KERNEL, 0)
    gradient = cv2.magnitude(
        cv2.Sobel(blurred, cv2.CV_32F, 1, 0, ksize=3),
        cv2.Sobel(blurred, cv2.CV_32F, 0, 1, ksize=3),
    )
    strong = max(
        float(np.percentile(gradient, EDGE_SUPPORT_GRADIENT_PERCENTILE)),
        EDGE_SUPPORT_MIN_GRADIENT,
    )
    height, width = gradient.shape

    steps = (np.arange(EDGE_SUPPORT_SAMPLES, dtype=np.float32) + 0.5) / EDGE_SUPPORT_SAMPLES
    offsets = np.arange(-EDGE_SUPPORT_PERP_PX, EDGE_SUPPORT_PERP_PX + 1, dtype=np.float32)

    fractions: list[float] = []
    for index in range(4):
        start = quad[index]
        direction = quad[(index + 1) % 4] - start
        length = float(np.linalg.norm(direction))
        if length < 1e-6:
            fractions.append(0.0)
            continue
        normal = np.array([-direction[1], direction[0]], dtype=np.float32) / length

        along = start + np.outer(steps, direction)  # (samples, 2)
        points = along[:, None, :] + normal[None, None, :] * offsets[None, :, None]

        xs = points[..., 0]
        ys = points[..., 1]
        inside = (xs >= 0) & (xs <= width - 1) & (ys >= 0) & (ys <= height - 1)
        col = np.clip(np.rint(xs).astype(np.intp), 0, width - 1)
        row = np.clip(np.rint(ys).astype(np.intp), 0, height - 1)

        sampled = np.where(inside, gradient[row, col], 0.0)
        fractions.append(float((sampled.max(axis=1) >= strong).mean()))
    return fractions


def _quad_is_trustworthy(gray: np.ndarray, quad: np.ndarray) -> bool:
    """Reject a quad that is card-SHAPED but not the card's actual outline.

    `quad` is in DETECTION space, matching `gray`. See the constants block
    for why aspect error alone cannot make this call.
    """
    side_ratio = _opposite_side_ratio(quad)
    if side_ratio > MAX_OPPOSITE_SIDE_RATIO:
        logger.info(
            "deskew: opposing sides differ by %.2fx (max %.2fx) — quad is not a "
            "photographed rectangle, declining",
            side_ratio,
            MAX_OPPOSITE_SIDE_RATIO,
        )
        return False

    supports = _edge_support_fractions(gray, quad)
    unsupported = sum(1 for fraction in supports if fraction < MIN_EDGE_SUPPORT_FRACTION)
    if unsupported > MAX_UNSUPPORTED_EDGES:
        logger.info(
            "deskew: %d of 4 quad edges lack gradient support (max %d allowed); "
            "per-edge %s — quad is inside the card, declining",
            unsupported,
            MAX_UNSUPPORTED_EDGES,
            [round(fraction, 2) for fraction in supports],
        )
        return False
    return True


def _detection_masks(gray: np.ndarray) -> list[np.ndarray]:
    """Build the binary masks a card outline might show up in.

    Three complementary views, because no single one covers the corpus:
      - Canny + close  — works on textured backgrounds (wood, cloth) where
        card and background have similar brightness.
      - Otsu           — card lighter than background (black scanner bed).
      - Otsu inverted  — card darker than background (white paper).

    All three are searched and the best quad across all of them wins; they
    are not tried in order.
    """
    import cv2

    blurred = cv2.GaussianBlur(gray, BLUR_KERNEL, 0)

    edges = cv2.Canny(blurred, CANNY_LOW, CANNY_HIGH)
    kernel = np.ones((CLOSE_KERNEL_PX, CLOSE_KERNEL_PX), np.uint8)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel)

    _threshold_value, otsu = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    return [edges, otsu, cv2.bitwise_not(otsu)]


def _select_best_candidate(
    candidates: list[tuple[float, float, np.ndarray]],
) -> tuple[float, float, np.ndarray] | None:
    """Pick the winning `(aspect_error, area_fraction, quad)` — or None.

    The whole ranking policy lives here, isolated from OpenCV so it can be
    reasoned about and tested on its own:

      1. Lowest aspect error leads. Area must not lead — the image border
         is the largest quad in every frame.
      2. But it leads only *decisively*: everything within
         `ASPECT_SIGNIFICANCE_BAND` of the best error is a contender, and
         among contenders the OUTERMOST (largest area) wins. This is what
         stops a card's inner panel, which is often a hair closer to card
         aspect than the card's own outline, from taking the crop.
      3. If the winner is frame-sized, there is nothing to deskew and the
         caller gets None.
    """
    if not candidates:
        return None

    lowest_error = min(error for error, _area, _quad in candidates)
    contenders = [c for c in candidates if c[0] <= lowest_error + ASPECT_SIGNIFICANCE_BAND]
    best = max(contenders, key=lambda candidate: candidate[1])

    if best[1] >= FRAME_AREA_FRACTION:
        logger.info(
            "deskew: best quad is the image frame (area_frac=%.3f) — nothing to deskew",
            best[1],
        )
        return None
    return best


def _find_card_quad(bgr: np.ndarray) -> np.ndarray | None:
    """Locate the card's four corners, in ORIGINAL image coordinates.

    Detection runs on a downscaled copy; the returned quad is divided back
    out by the scale so callers warp the full-resolution original.

    Candidates are ranked by aspect error against the standard card
    aspects; among those within `ASPECT_SIGNIFICANCE_BAND` of the best, the
    largest wins. Ranking by area alone picks the image border on
    effectively every image — see the module docstring. Returns None if the
    image boundary itself wins the ranking (see `FRAME_AREA_FRACTION`) or
    if nothing card-shaped was found.
    """
    import cv2

    height, width = bgr.shape[:2]
    scale = min(DETECT_MAX_SIDE_PX / max(height, width), 1.0)
    if scale < 1.0:
        small = cv2.resize(
            bgr,
            (max(1, int(width * scale)), max(1, int(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
    else:
        small = bgr

    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    frame_area = float(gray.shape[0] * gray.shape[1])

    candidates: list[tuple[float, float, np.ndarray]] = []

    for mask in _detection_masks(gray):
        contours, _hierarchy = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        ranked = sorted(contours, key=cv2.contourArea, reverse=True)[:MAX_CONTOURS_PER_MASK]
        for contour in ranked:
            perimeter = cv2.arcLength(contour, True)
            if perimeter <= 0:
                continue
            for epsilon_fraction in APPROX_EPSILON_FRACTIONS:
                approx = cv2.approxPolyDP(contour, epsilon_fraction * perimeter, True)
                if len(approx) != 4 or not cv2.isContourConvex(approx):
                    continue

                quad = _order_corners(approx)
                # Area of the QUAD, not of the source contour: approxPolyDP
                # may have straightened a ragged outline, and both the size
                # ranking and the frame check below have to see what we
                # would actually warp.
                quad_area = abs(float(cv2.contourArea(quad)))
                area_fraction = quad_area / frame_area if frame_area else 0.0
                if area_fraction < MIN_QUAD_AREA_FRACTION:
                    continue

                quad_width, quad_height = _quad_side_lengths(quad)
                if quad_width < MIN_WARPED_SIDE_PX or quad_height < MIN_WARPED_SIDE_PX:
                    continue

                aspect_error = _card_aspect_error(quad_width, quad_height)
                if aspect_error > DETECT_ASPECT_TOLERANCE:
                    continue

                # Kept in DETECTION space: the integrity gate below samples
                # `gray`, so the winner has to still be in its coordinates.
                # The scale is divided back out once, on the way out.
                candidates.append((aspect_error, area_fraction, quad))

    best = _select_best_candidate(candidates)
    if best is None:
        return None

    best_aspect_error, best_area_fraction, best_quad = best

    # Card-shaped is not the same as being the card. Vetted here rather than
    # in `_finalize_quad` because this is the last point at which the
    # detection-space image is still in hand.
    if not _quad_is_trustworthy(gray, best_quad):
        return None

    logger.info(
        "deskew: quad aspect_err=%.3f area_frac=%.3f",
        best_aspect_error,
        best_area_fraction,
    )
    return best_quad / scale


def _finalize_quad(
    quad: np.ndarray, image_size: tuple[int, int]
) -> tuple[np.ndarray, int, int] | None:
    """Add the safety margin, clamp to the image, and vet the result.

    Returns `(quad, out_width, out_height)` ready to warp, or None to
    decline. Declining here is the module's core conservatism: a warped
    output far off card aspect means the quad was mis-detected — almost
    always a corner inside the card, which crops the card down — and a
    clipped card is unrecoverable downstream. The cascade continues to the
    next strategy instead.
    """
    width, height = _quad_side_lengths(quad)
    margin_px = QUAD_MARGIN_FRACTION * min(width, height)
    final = _clamp_quad(_expand_quad(quad, margin_px), image_size)

    out_width, out_height = _quad_side_lengths(final)
    out_w = int(round(out_width))
    out_h = int(round(out_height))
    if out_w < 1 or out_h < 1:
        return None

    output_error = _card_aspect_error(out_w, out_h)
    if output_error > MAX_OUTPUT_ASPECT_ERROR:
        logger.info(
            "deskew: warped output %dx%d is %.1f%% off card aspect (max %.1f%%) — declining",
            out_w,
            out_h,
            output_error * 100,
            MAX_OUTPUT_ASPECT_ERROR * 100,
        )
        return None
    return final, out_w, out_h


def _warp(bgr: np.ndarray, quad: np.ndarray) -> np.ndarray | None:
    """Perspective-correct `bgr` so `quad` becomes the full output rectangle."""
    import cv2

    image_height, image_width = bgr.shape[:2]
    finalized = _finalize_quad(quad, (image_width, image_height))
    if finalized is None:
        return None
    expanded, out_w, out_h = finalized

    destination = np.array(
        [[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]],
        dtype=np.float32,
    )
    transform = cv2.getPerspectiveTransform(expanded, destination)
    return cv2.warpPerspective(
        bgr,
        transform,
        (out_w, out_h),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )


def deskew_crop(image_bytes: bytes) -> bytes | None:
    """Perspective-correct the card in `image_bytes` and return it as JPEG.

    Returns None when no card-shaped quadrilateral was found, mirroring the
    Swift original's "no rectangle feature → pass the file through
    untouched" behaviour: the cascade simply advances to the next strategy
    rather than this stage inventing a crop. None is also returned for
    unreadable input and for any OpenCV failure — a cropper that raises
    would take out the whole cascade.

    The returned bytes are at full source resolution: detection runs on a
    ≤`DETECT_MAX_SIDE_PX` copy but the warp is applied to the original.
    """
    import cv2

    if not image_bytes:
        return None

    try:
        buffer = np.frombuffer(image_bytes, np.uint8)
        bgr = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    except Exception:  # noqa: BLE001
        logger.exception("deskew: cannot decode image")
        return None
    if bgr is None:
        logger.info("deskew: cv2.imdecode returned None")
        return None

    try:
        quad = _find_card_quad(bgr)
    except Exception:  # noqa: BLE001
        logger.exception("deskew: quad detection failed")
        return None
    if quad is None:
        logger.info("deskew: no card-shaped quad found")
        return None

    try:
        warped = _warp(bgr, quad)
        if warped is None or warped.size == 0:
            return None
        ok, encoded = cv2.imencode(
            ".jpg", warped, [int(cv2.IMWRITE_JPEG_QUALITY), OUTPUT_JPEG_QUALITY]
        )
        if not ok:
            logger.warning("deskew: cv2.imencode failed")
            return None
        return bytes(encoded)
    except Exception:  # noqa: BLE001
        logger.exception("deskew: warp failed")
        return None
