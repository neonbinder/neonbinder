"""FAST-role quad crop (NEO-320): find one card's four corners, warp it flat.

An OpenCV port of the idea behind Core Image's `CIDetector` rectangle
detector plus `CIPerspectiveCorrection`: find a convex four-sided outline,
then one perspective warp to an axis-aligned card. It runs in the FAST role
after the identity checks, on any frame they did not accept, and it costs
well under a second, where the HEAVY role's BiRefNet pass costs ~40 s.

**Every decision here rests on the pixels.** Nothing reads where the image
came from: no EXIF make or model, no resolution, no device-shaped pixel
dimensions. A quad detector on its own is not safe — it happily returns the
printed inner border of a card (a shave), a rectangle of scanner bed around
the card (loose), or one of several cards — so a candidate becomes a crop only
when the content checks below all agree, and each refusal is a named reason
that `crop()` logs. A refusal is not a failure: the frame goes to the HEAVY
role exactly as it did before this stage existed.

Detection (work resolution, `tiered.WORK_LONG`):
  several edge maps — Canny on CLAHE grey and on LAB L at two blurs and two
  threshold pairs, plus `tiered`'s background-distance masks — then every
  contour's convex hull is simplified to a polygon and kept only as a convex
  quadrilateral covering at least MIN_AREA_FRAC of the frame, with every
  corner within MAX_CORNER_DEV of 90 degrees and a side ratio inside the card
  window (2.5:3.5, either orientation).

Refinement: each side is fitted (Huber) to the contour points along it, then
slid and tilted a little onto the line of strongest colour gradient, and the
four lines are intersected. This is the perspective-aware generalisation of
`tiered.line_fit_quad`, which fits to an oriented box and falls back to that
box whenever a corner leaves 90 +/- 5 degrees — exactly the keystoned case a
phone photo produces. A quad is "supported" when every side has gradient
along most of its length; the largest supported quad is the candidate, and a
smaller quad nested inside it (a printed panel) is never preferred.

Content checks on the candidate, in order (each a decline reason):
  weak_edges   no candidate has gradient support along all four sides
  off_aspect   the refined quad has drifted off 2.5:3.5: a side was fitted to
               something other than the card's edge
  multi_card   another supported card-shaped quad that does not overlap it
  tight_frame  the quad's margin to the frame edge is thin on every side: the
               frame already is the card and the quad is its printed border
  shaved       the band just outside a side is mostly out of frame, or is not
               background: it matches neither the frame-border background
               estimate nor the surface further out on the same side (phone
               photos need the second: the mat behind one side is often not
               the frame border's colour)
  loose        the crop's border ring is still background-coloured
               (`tiered.bg_residual`), or one side's inner band is
  shaved       more than one side's edge band is indistinguishable from what
               lies outside it; or a fainter line runs parallel just outside a
               side AND stops where the side stops (a card's true outer edge;
               a scanner streak or table edge carries on past the corners and
               is ignored); or a larger supported card-shaped outline encloses
               the quad
Then the cascade's own validator and Vision text gate run on the crop as for
every other stage.

The constants below were tuned together against a labelled set of real phone
photos and scanner beds (private; see the README). Re-run that evaluation
rather than adjusting one alone.

Public API: `quad_crop(image_bytes) -> QuadResult`.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

from app.cropper import tiered

logger = logging.getLogger(__name__)

# ── Detection ───────────────────────────────────────────────────────────────

MIN_AREA_FRAC = 0.10  # candidate quad must cover this much of the frame
MAX_FRAME_FRAC = 0.90  # bigger than this is the frame itself handed back
MAX_CORNER_DEV = 25.0  # degrees from 90 a corner may lean (perspective)
ASPECT_WINDOW = 0.05  # |short/long - 2.5/3.5| allowed for a candidate
FINAL_ASPECT_WINDOW = 0.025  # ...and for the refined quad that becomes the crop
APPROX_EPS = (0.02, 0.035)  # approxPolyDP epsilon as a fraction of perimeter
CANNY_LEVELS = ((15, 45), (40, 120))
BLUR_KERNELS = (3, 7)

# ── Refinement ──────────────────────────────────────────────────────────────

REFINE_RANGE = 4.0  # work px a side may slide along its normal
REFINE_STEP = 0.5
SIDE_SAMPLES = 48  # points sampled along each side (corners excluded)
SIDE_T = (0.12, 0.88)  # sampled span of each side, as fractions of its length
TILTS = (-1.0, -0.5, 0.0, 0.5, 1.0)  # degrees a side may rotate while refining

# ── Content checks ──────────────────────────────────────────────────────────

MULTI_MIN_AREA = 0.35  # another quad this big relative to the candidate counts
MULTI_MAX_OVERLAP = 0.10  # ...when it overlaps the candidate less than this

TIGHT_FRAME_MARGIN = 0.08  # every margin below this (x quad side) => tight
ENCLOSING_MIN = 1.08  # a card-shaped quad this much bigger, containing ours...
ENCLOSING_SUPPORT = 0.35  # ...with at least this edge support on every side

RING_NEAR = 0.012  # outside/inside bands start this far from the side (x short side)
RING_FAR = 0.045  # ...and end this far
FAR_BAND = (0.05, 0.12)  # the same side's background further out (x short side)
BG_DIST = 16.0  # LAB distance (L weighted 0.5) under which a pixel is background
OUTSIDE_BG_MIN = 0.60  # fraction of a side's outside band that must be background
OUTSIDE_IN_FRAME_MIN = 0.30  # fraction of the outside band that must be in frame
SIDE_CONTRAST_MIN = 12.0  # LAB distance between a side's outside and inside medians

PARALLEL_SEARCH = (0.02, 0.16)  # outer-line search band beyond each side (x short side)
PARALLEL_RATIO = 2.5  # outer line must exceed this x the band's median gradient
PARALLEL_FLOOR = 8.0  # ...and this absolute gradient
PARALLEL_SUPPORT = 0.50  # an outer line this coherent along a side => shaved
PARALLEL_EXTEND = (0.08, 0.30)  # beyond each end of the side (x side length)...
PARALLEL_BEYOND = (1.0 + PARALLEL_EXTEND[0], 1.0 + PARALLEL_EXTEND[1])
PARALLEL_CONTINUES = 0.35  # ...a line this coherent there is a streak, not a card
PARALLEL_DRIFT = 0.012  # rows (x short side) a continuing streak may drift

LOOSE_RESIDUAL_MAX = 0.25  # tiered.bg_residual of the work crop
LOOSE_BAND_FRAC = 0.70  # a side's inside band this background => loose

EDGE_GRAD_MIN = 18.0  # gradient magnitude a sample needs to count as edge
EDGE_SUPPORT_MIN = 0.65  # fraction of samples per side that must be edge

OUTPUT_JPEG_QUALITY = tiered.OUTPUT_JPEG_QUALITY

DECLINE_REASONS: tuple[str, ...] = (
    "undecodable",
    "no_quad",
    "multi_card",
    "tight_frame",
    "shaved",
    "loose",
    "weak_edges",
    "off_aspect",
    "error",
)


@dataclass(frozen=True)
class QuadResult:
    """Outcome of `quad_crop`.

    `crop_bytes` is a JPEG of the warped card when every content check
    passed, else None with `reason` naming the check that declined. `quad`
    is the candidate's corners in full-resolution pixels (ordered, clockwise
    from top-left) whenever one was found, accepted or not. `diagnostics`
    holds the measured numbers behind the verdict, for logs and tuning; it
    never holds image data.
    """

    crop_bytes: bytes | None
    reason: str
    quad: np.ndarray | None = None
    diagnostics: dict[str, Any] = field(default_factory=dict)

    @property
    def accepted(self) -> bool:
        return self.crop_bytes is not None


# ── Geometry helpers ────────────────────────────────────────────────────────


def _corner_angles(quad: np.ndarray) -> list[float]:
    out = []
    for i in range(4):
        a, b, c = quad[(i - 1) % 4], quad[i], quad[(i + 1) % 4]
        v1, v2 = a - b, c - b
        cosang = float(np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-9))
        out.append(math.degrees(math.acos(max(-1.0, min(1.0, cosang)))))
    return out


def _side_lengths(quad: np.ndarray) -> tuple[float, float]:
    """(mean width, mean height) of an ordered quad."""
    w = (np.linalg.norm(quad[1] - quad[0]) + np.linalg.norm(quad[2] - quad[3])) / 2
    h = (np.linalg.norm(quad[3] - quad[0]) + np.linalg.norm(quad[2] - quad[1])) / 2
    return float(w), float(h)


def _aspect(quad: np.ndarray) -> float:
    w, h = _side_lengths(quad)
    return min(w, h) / max(w, h, 1e-9)


def _area(quad: np.ndarray) -> float:
    return float(cv2.contourArea(quad.astype(np.float32)))


def _overlap(a: np.ndarray, b: np.ndarray) -> float:
    """Intersection area over the smaller quad's area."""
    inter, _ = cv2.intersectConvexConvex(a.astype(np.float32), b.astype(np.float32))
    return float(inter) / max(1e-9, min(_area(a), _area(b)))


def _sides(quad: np.ndarray) -> list[tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """Per side: (start point, end point, outward unit normal)."""
    c = quad.mean(axis=0)
    out = []
    for i in range(4):
        p0, p1 = quad[i], quad[(i + 1) % 4]
        d = p1 - p0
        n = np.array([d[1], -d[0]], dtype=np.float64)
        n /= np.linalg.norm(n) + 1e-9
        if np.dot((p0 + p1) / 2 - c, n) < 0:
            n = -n
        out.append((p0.astype(np.float64), p1.astype(np.float64), n))
    return out


def _intersect_lines(p0, d0, p1, d1) -> np.ndarray:
    return tiered._intersect(p0, d0, p1, d1)


# ── Sampling ────────────────────────────────────────────────────────────────


def _sample(img: np.ndarray, pts: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Bilinear samples of `img` at float (x, y) points; returns (values, in_frame)."""
    h, w = img.shape[:2]
    xs = pts[..., 0].astype(np.float32)
    ys = pts[..., 1].astype(np.float32)
    inside = (xs >= 0) & (xs <= w - 1) & (ys >= 0) & (ys <= h - 1)
    vals = cv2.remap(
        img,
        xs.reshape(1, -1),
        ys.reshape(1, -1),
        cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )
    vals = vals.reshape(*xs.shape, *img.shape[2:]) if img.ndim == 3 else vals.reshape(xs.shape)
    return vals, inside


def _side_points(p0: np.ndarray, p1: np.ndarray, n: np.ndarray, offsets: np.ndarray) -> np.ndarray:
    """Grid of points: rows = offsets along the normal, cols = positions along the side."""
    t = np.linspace(SIDE_T[0], SIDE_T[1], SIDE_SAMPLES)
    base = p0[None, :] + t[:, None] * (p1 - p0)[None, :]
    return base[None, :, :] + offsets[:, None, None] * n[None, None, :]


def _gradient(work: np.ndarray) -> np.ndarray:
    """Colour gradient magnitude: the max over LAB channels of the Sobel norm."""
    lab = cv2.cvtColor(cv2.GaussianBlur(work, (3, 3), 0), cv2.COLOR_BGR2LAB).astype(np.float32)
    mags = []
    for ch in range(3):
        gx = cv2.Sobel(lab[..., ch], cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(lab[..., ch], cv2.CV_32F, 0, 1, ksize=3)
        mags.append(cv2.magnitude(gx, gy) / 4.0)
    return np.max(np.stack(mags), axis=0)


# ── Detection ───────────────────────────────────────────────────────────────


def _edge_maps(work: np.ndarray) -> list[np.ndarray]:
    gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
    gray = cv2.createCLAHE(2.0, (8, 8)).apply(gray)
    lum = cv2.cvtColor(work, cv2.COLOR_BGR2LAB)[..., 0]
    k3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    maps: list[np.ndarray] = []
    for src in (gray, lum):
        for k in BLUR_KERNELS:
            blurred = cv2.GaussianBlur(src, (k, k), 0)
            for lo, hi in CANNY_LEVELS:
                edges = cv2.Canny(blurred, lo, hi)
                maps.append(cv2.morphologyEx(edges, cv2.MORPH_CLOSE, k3))
    for l_weight in (0.5, 1.0):
        mask = tiered._bg_distance_mask(work, l_weight)
        if mask is not None:
            maps.append(mask)
    return maps


def _candidates(work: np.ndarray) -> list[tuple[np.ndarray, np.ndarray]]:
    """Every card-shaped convex quad in any edge map as (quad, hull points),
    deduplicated, largest first."""
    h, w = work.shape[:2]
    frame = float(h * w)
    found: list[tuple[np.ndarray, np.ndarray]] = []
    for emap in _edge_maps(work):
        cnts, _ = cv2.findContours(emap, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
        for cnt in cnts:
            hull = cv2.convexHull(cnt)
            area = cv2.contourArea(hull)
            if area < MIN_AREA_FRAC * frame or area > MAX_FRAME_FRAC * frame:
                continue
            peri = cv2.arcLength(hull, True)
            for eps in APPROX_EPS:
                poly = cv2.approxPolyDP(hull, eps * peri, True)
                if len(poly) != 4 or not cv2.isContourConvex(poly):
                    continue
                quad = tiered.order_quad(poly.reshape(4, 2).astype(np.float64))
                if not _card_shaped(quad):
                    continue
                found.append((quad, cnt.reshape(-1, 2).astype(np.float64)))
                break
    found.sort(key=lambda c: _area(c[0]), reverse=True)
    unique: list[tuple[np.ndarray, np.ndarray]] = []
    for q, pts in found:
        tol = 0.02 * math.sqrt(_area(q))
        if any(np.max(np.linalg.norm(q - u, axis=1)) < tol for u, _ in unique):
            continue
        unique.append((q, pts))
    return unique


def _card_shaped(quad: np.ndarray) -> bool:
    if any(abs(a - 90.0) > MAX_CORNER_DEV for a in _corner_angles(quad)):
        return False
    return abs(_aspect(quad) - tiered.CARD_ASPECT) <= ASPECT_WINDOW


# ── Refinement ──────────────────────────────────────────────────────────────


def _fit_side(pts: np.ndarray, p0: np.ndarray, p1: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Huber line through the contour points lying along one side of the
    approximate quad (the perspective-aware `tiered.line_fit_quad` step)."""
    v = p1 - p0
    length = float(np.linalg.norm(v)) + 1e-9
    u = v / length
    d = np.abs((pts[:, 0] - p0[0]) * u[1] - (pts[:, 1] - p0[1]) * u[0])
    t = (pts - p0) @ u
    band = max(3.0, 0.02 * length)
    sel = pts[(d < band) & (t > 0.1 * length) & (t < 0.9 * length)]
    if len(sel) < 10:
        return p0, u
    vx, vy, x0, y0 = cv2.fitLine(sel.astype(np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).flatten()
    direction = np.array([vx, vy], dtype=np.float64)
    if np.dot(direction, u) < 0:
        direction = -direction
    return np.array([x0, y0], dtype=np.float64), direction


def _refine(quad: np.ndarray, pts: np.ndarray, grad: np.ndarray) -> tuple[np.ndarray, list[float]]:
    """Fit each side to its contour points, then slide and tilt it onto the
    strongest gradient line. Returns (quad, per-side edge support)."""
    offsets = np.arange(-REFINE_RANGE, REFINE_RANGE + 1e-9, REFINE_STEP)
    lines = []
    support = []
    for p0, p1, n in _sides(quad):
        origin, direction = _fit_side(pts, p0, p1)
        # Re-express the fitted line as a segment spanning the side.
        a = origin + ((p0 - origin) @ direction) * direction
        b = origin + ((p1 - origin) @ direction) * direction
        mid = (a + b) / 2
        half = (b - a) / 2
        best = (-1.0, a, b, None, 0)
        for tilt in TILTS:
            c, s = math.cos(math.radians(tilt)), math.sin(math.radians(tilt))
            rh = np.array([c * half[0] - s * half[1], s * half[0] + c * half[1]])
            ta, tb = mid - rh, mid + rh
            nn = np.array([rh[1], -rh[0]])
            nn /= np.linalg.norm(nn) + 1e-9
            if np.dot(nn, n) < 0:
                nn = -nn
            vals, _ = _sample(grad, _side_points(ta, tb, nn, offsets))
            means = vals.mean(axis=1)
            k = int(np.argmax(means))
            if means[k] > best[0]:
                best = (float(means[k]), ta + offsets[k] * nn, tb + offsets[k] * nn, vals, k)
        _, ba, bb, vals, k = best
        lo, hi = max(0, k - 2), min(len(offsets), k + 3)
        support.append(float(np.mean(vals[lo:hi].max(axis=0) >= EDGE_GRAD_MIN)))
        lines.append((ba, (bb - ba) / (np.linalg.norm(bb - ba) + 1e-9)))
    refined = np.array(
        [_intersect_lines(*lines[(i - 1) % 4], *lines[i]) for i in range(4)], dtype=np.float64
    )
    return tiered.order_quad(refined), support


# ── Content checks ──────────────────────────────────────────────────────────


def _lab_dist(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    d = a - b
    return np.sqrt((0.5 * d[..., 0]) ** 2 + d[..., 1] ** 2 + d[..., 2] ** 2)


def _band(
    lab: np.ndarray, p0: np.ndarray, p1: np.ndarray, n: np.ndarray, lo: float, hi: float
) -> tuple[np.ndarray, float]:
    """In-frame LAB samples of the band `lo..hi` px along the side's normal."""
    vals, inside = _sample(lab, _side_points(p0, p1, n, np.linspace(lo, hi, 5)))
    return vals[inside], float(inside.mean())


def _ring_stats(
    quad: np.ndarray, lab: np.ndarray, bg: np.ndarray, short: float
) -> list[dict[str, float]]:
    """Per side: is the band just outside the quad background, and is it
    distinct from the crop's own edge band?

    Background is judged two ways, either of which suffices: the near band
    matches the frame-border background estimate, or it matches the band
    further out on the same side (the surface the card lies on simply
    continues). Phone photos need the second: the mat behind one side of the
    card is often not the colour of the frame border on another.
    """
    out = []
    for p0, p1, n in _sides(quad):
        near, in_frame = _band(lab, p0, p1, n, RING_NEAR * short, RING_FAR * short)
        far, far_in = _band(lab, p0, p1, n, FAR_BAND[0] * short, FAR_BAND[1] * short)
        inner, _ = _band(lab, p0, p1, -n, RING_NEAR * short, RING_FAR * short)
        stats = {"in_frame": round(in_frame, 3), "outside_bg": 0.0, "outside_far": 0.0}
        i_med = np.median(inner, axis=0)
        stats["inside_bg"] = round(float(np.mean(_lab_dist(inner, bg) < BG_DIST)), 3)
        if len(near):
            n_med = np.median(near, axis=0)
            stats["outside_bg"] = round(float(np.mean(_lab_dist(near, bg) < BG_DIST)), 3)
            if far_in >= 0.2 and len(far):
                f_med = np.median(far, axis=0)
                stats["outside_far"] = round(float(np.mean(_lab_dist(near, f_med) < BG_DIST)), 3)
            stats["contrast"] = round(float(_lab_dist(n_med, i_med)), 1)
        else:
            stats["contrast"] = 0.0
        out.append(stats)
    return out


def _peak_rows(
    vals: np.ndarray, inside: np.ndarray, floor: float, min_in: float = 0.9
) -> np.ndarray:
    """Per row (offset), the fraction of in-frame samples where that row is a
    gradient peak above `floor`; rows with less than `min_in` of their
    samples in frame score 0."""
    peak = np.zeros_like(vals, dtype=bool)
    peak[1:-1] = (vals[1:-1] >= vals[:-2]) & (vals[1:-1] >= vals[2:])
    hit = (vals >= floor) & peak
    # Let the line wander one row (perspective, sampling).
    hit[1:] |= hit[:-1].copy()
    row_in = inside.mean(axis=1) >= min_in
    return np.where(row_in, (hit & inside).sum(axis=1) / np.maximum(1, inside.sum(axis=1)), 0.0)


def _outer_lines(quad: np.ndarray, grad: np.ndarray, short: float) -> list[float]:
    """Per side: coherence of the best line running parallel just OUTSIDE it
    that also STOPS where the side stops.

    The coherence is the fraction of sample points along the side where that
    line is a gradient peak (0 when the band leaves the frame). A card's true
    outer edge beyond a printed inner border shows up here even when it is
    too faint to have made a quad of its own (white border on a white bed).
    A line that carries on past the side's ends is not a card edge — it is
    a scanner-lid streak, a table edge or a mat seam — and is ignored.
    """
    out = []
    lo, hi = PARALLEL_SEARCH[0] * short, PARALLEL_SEARCH[1] * short
    offs = np.arange(lo, hi, 1.0)
    for p0, p1, n in _sides(quad):
        if len(offs) == 0:
            out.append(0.0)
            continue
        vals, inside = _sample(grad, _side_points(p0, p1, n, offs))
        floor = max(PARALLEL_FLOOR, PARALLEL_RATIO * float(np.median(vals[inside])))
        along = _peak_rows(vals, inside, floor)
        # The same rows beyond both ends of the side.
        d = p1 - p0
        ext = []
        for t0, t1 in ((-PARALLEL_EXTEND[1], -PARALLEL_EXTEND[0]), PARALLEL_BEYOND):
            e_vals, e_in = _sample(grad, _side_points(p0 + t0 * d, p0 + t1 * d, n, offs))
            ext.append(_peak_rows(e_vals, e_in, floor, min_in=0.2))
        beyond = np.maximum(ext[0], ext[1])
        # A streak that is not exactly parallel to the side drifts a few rows
        # over the extension, so look for it in a window of neighbouring rows.
        win = max(2, int(round(PARALLEL_DRIFT * short)))
        drift = np.array([beyond[max(0, i - win) : i + win + 1].max() for i in range(len(beyond))])
        bounded = np.where(drift < PARALLEL_CONTINUES, along, 0.0)
        out.append(round(float(bounded.max()), 3))
    return out


# ── Pipeline ────────────────────────────────────────────────────────────────


def _encode(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), OUTPUT_JPEG_QUALITY])
    if not ok:
        raise RuntimeError("cv2.imencode failed")
    return bytes(buf)


def _run(full: np.ndarray, work: np.ndarray, scale: float) -> QuadResult:
    h, w = work.shape[:2]
    cands = _candidates(work)
    diag: dict[str, Any] = {"n_candidates": len(cands)}
    if not cands:
        return QuadResult(None, "no_quad", diagnostics=diag)

    grad = _gradient(work)
    lab = cv2.cvtColor(work, cv2.COLOR_BGR2LAB).astype(np.float32)
    bg = tiered.border_bg_lab(lab)

    refined: list[tuple[np.ndarray, list[float]]] = []
    for raw, pts in cands:
        quad, support = _refine(raw, pts, grad)
        if _card_shaped(quad):
            refined.append((quad, support))
    supported = [(q, s) for q, s in refined if min(s) >= EDGE_SUPPORT_MIN]
    diag["n_supported"] = len(supported)
    if not supported:
        return QuadResult(None, "weak_edges", diagnostics=diag)

    quad, support = supported[0]
    qw, qh = _side_lengths(quad)
    short = min(qw, qh)
    diag.update(
        area_frac=round(_area(quad) / (h * w), 3),
        aspect=round(_aspect(quad), 4),
        angles=[round(a, 1) for a in _corner_angles(quad)],
        support=[round(s, 3) for s in support],
    )
    full_quad = quad / scale

    def decline(reason: str) -> QuadResult:
        return QuadResult(None, reason, quad=full_quad, diagnostics=diag)

    # A flat card warps to 2.5:3.5; a refined quad well off it has a side
    # fitted to something other than the card's edge.
    if abs(_aspect(quad) - tiered.CARD_ASPECT) > FINAL_ASPECT_WINDOW:
        return decline("off_aspect")

    # single card
    others = [
        q
        for q, _ in supported[1:]
        if _area(q) >= MULTI_MIN_AREA * _area(quad) and _overlap(q, quad) < MULTI_MAX_OVERLAP
    ]
    diag["n_separate"] = len(others)
    if others:
        return decline("multi_card")

    # a larger card-shaped outline around this one => this one is a printed panel
    enclosing = [
        [round(v, 2) for v in s]
        for q, s in refined
        if _area(q) > ENCLOSING_MIN * _area(quad) and _overlap(q, quad) > 0.95
    ]
    diag["enclosing"] = enclosing

    # the quad nearly fills the frame: the frame is the card, the quad its border
    xs, ys = quad[:, 0], quad[:, 1]
    margins = [
        float(xs.min()) / qw,
        float(w - 1 - xs.max()) / qw,
        float(ys.min()) / qh,
        float(h - 1 - ys.max()) / qh,
    ]
    diag["margins"] = [round(m, 3) for m in margins]
    if max(margins) < TIGHT_FRAME_MARGIN:
        return decline("tight_frame")

    # outside is background
    rings = _ring_stats(quad, lab, bg, short)
    diag["rings"] = rings
    outer = _outer_lines(quad, grad, short)
    diag["outer_lines"] = outer
    for r in rings:
        if r["in_frame"] < OUTSIDE_IN_FRAME_MIN:
            return decline("shaved")
        if max(r["outside_bg"], r["outside_far"]) < OUTSIDE_BG_MIN:
            return decline("shaved")

    # inside is card (checked before the remaining shave tests so a quad that
    # merely encloses background is named for what it is)
    crop_w, _, _ = tiered.warp_rect_card(work, quad, 0.0)
    residual = tiered.bg_residual(crop_w, bg)
    diag["bg_residual"] = round(residual, 3)
    if residual > LOOSE_RESIDUAL_MAX or any(r["inside_bg"] >= LOOSE_BAND_FRAC for r in rings):
        return decline("loose")

    # the edge band is distinct from what lies outside, and no fainter card
    # edge runs outside the quad
    if sum(r["contrast"] < SIDE_CONTRAST_MIN for r in rings) > 1:
        return decline("shaved")
    if max(outer) >= PARALLEL_SUPPORT:
        return decline("shaved")
    if any(min(s) >= ENCLOSING_SUPPORT for s in enclosing):
        return decline("shaved")

    crop, aspect, snapped = tiered.warp_rect_card(full, full_quad, 0.0)
    if crop.shape[0] < crop.shape[1]:
        crop = cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE)
    diag.update(snapped=snapped, crop_wh=[int(crop.shape[1]), int(crop.shape[0])])
    return QuadResult(_encode(crop), "ok", quad=full_quad, diagnostics=diag)


def quad_crop(image_bytes: bytes) -> QuadResult:
    """Find one card's quad and warp it flat, or say which check declined.

    Never raises: an undecodable image or an internal failure is a decline
    (`undecodable` / `error`), which the cascade treats like any other.
    """
    try:
        full, work, scale = tiered._load(image_bytes)
    except Exception as exc:  # noqa: BLE001
        logger.warning("quad_crop: cannot open image: %s", exc)
        return QuadResult(None, "undecodable")
    try:
        return _run(full, work, scale)
    except Exception:
        logger.exception("quad_crop: pipeline failed")
        return QuadResult(None, "error")
