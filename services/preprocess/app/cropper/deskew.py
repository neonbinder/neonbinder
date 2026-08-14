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

# Expand the detected quad outward from its centroid by this fraction
# before warping. Detection runs at ≤1000px so each detection pixel is up
# to ~8 original pixels on a 50MP photo; a hair of outward slack means that
# quantization can only include a sliver of background rather than shave
# the card's own border off. Kept small — the Swift original pads not at
# all, and over-padding reintroduces the background wedges deskew removes.
QUAD_EXPAND_FRACTION = 0.005

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


def _expand_quad(quad: np.ndarray, fraction: float = QUAD_EXPAND_FRACTION) -> np.ndarray:
    """Scale the quad outward from its own centroid by `fraction`."""
    centroid = quad.mean(axis=0)
    return ((quad - centroid) * (1.0 + fraction) + centroid).astype(np.float32)


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

                candidates.append((aspect_error, area_fraction, quad / scale))

    best = _select_best_candidate(candidates)
    if best is None:
        return None

    best_aspect_error, best_area_fraction, best_quad = best
    logger.info(
        "deskew: quad aspect_err=%.3f area_frac=%.3f",
        best_aspect_error,
        best_area_fraction,
    )
    return best_quad


def _warp(bgr: np.ndarray, quad: np.ndarray) -> np.ndarray | None:
    """Perspective-correct `bgr` so `quad` becomes the full output rectangle."""
    import cv2

    expanded = _expand_quad(quad)
    quad_width, quad_height = _quad_side_lengths(expanded)
    out_w = int(round(quad_width))
    out_h = int(round(quad_height))
    if out_w < 1 or out_h < 1:
        return None

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
