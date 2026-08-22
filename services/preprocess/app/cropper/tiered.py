"""Tiered classical + BiRefNet card crop — port of the NEO-161 benchmark harness.

Ported from the standalone benchmark pipeline (human-verified 29/29 on the
stress corpus, 4 review rounds, 2026-08-16). The constants and logic here are
benchmark-tuned as a set — do NOT "improve" them individually; re-run the
corpus instead.

Mask sources share one geometry stage:

  classical  — multiple candidate masks (LAB background-distance at L-weights
               0.5/1.0, plus Canny hulls), each scored by the OUTCOME
               (bg_residual) of its provisional work-resolution crop
  birefnet   — rembg/BiRefNet alpha matte on a border-padded input (padding
               makes a frame-filling card an "object on background" again)
  tiered     — classical first; when classical can't produce a QC-gate pass,
               or can't settle the pre-cropped identity question, BiRefNet
               runs as the fallback. A classical gate-pass is additionally
               VERIFIED against BiRefNet (dark-on-dark border shaves are
               invisible to aspect gates), so BiRefNet inference is on the
               hot path for virtually every image — capacity-plan for it

Geometry: components → merge close fragments → hull → minAreaRect
  rectangular (hull/rect ≥ RECT_MIN) → 4-line-fit corners → one
      warpPerspective, snapped to exact 2.5:3.5 when within ASPECT_SNAP; a
      corner further than MAX_CORNER_DEV from 90° means a fitted line was
      dragged (shadow, glare) and the oriented box is used instead
  else (die-cut etc.)                → affine to the oriented rect, keep shape
Frame-filling detections are demoted (frame echo, score ×0.4) and can never
pass the QC gate. Detection runs at WORK_LONG resolution; final crop pixels
always come from the full-resolution original.

Service adaptations (the pipeline itself is untouched):

  - Input is image bytes, not a path; output is JPEG bytes of ONE crop — the
    highest-scoring component that passes the QC gate.
  - The benchmark's "identity" outcome (a card-aspect input frame is probably
    already cropped; re-cropping would eat the card) maps to **returning the
    input bytes untouched**: a card-aspect frame always clears the cascade's
    validator gates, so identity ends the cascade with the input as the
    result — the benchmark's passthrough. Declining instead would hand a
    pre-cropped card to pil_trim, which can shave its printed border.
    Classical evidence alone never settles identity — its frame-sized
    detections are echo artifacts — so BiRefNet gets the deciding vote,
    exactly as in the benchmark.
  - Components that only earn a "review" verdict (no QC-gate pass) also
    decline, letting the cascade's other strategies and uniform validator
    gates take over.
  - The BiRefNet session is lazily created on first use and cached for the
    container's lifetime (same pattern as `sam._load_model`). Model name
    comes from the `REMBG_MODEL` env var (default "birefnet-general");
    weights are baked into the image at build time via `U2NET_HOME`.

Public API: `tiered_crop(image_bytes) -> bytes | None`.
"""

from __future__ import annotations

import logging
import math
import os
import threading
from io import BytesIO
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageOps

logger = logging.getLogger(__name__)

# ── Constants (benchmark-tuned; see module docstring) ───────────────────────

WORK_LONG = 1200  # detection resolution (longest edge)
RECT_MIN = 0.92  # hull/rect area ratio at or above which the quad route runs
CARD_ASPECT = 2.5 / 3.5
ASPECT_SNAP = 0.020  # measured aspect this close to 2.5:3.5 → snap exactly
FRAME_CARD_WINDOW = 0.030  # input frame aspect this close to 2.5:3.5 => likely pre-cropped
MAX_CORNER_DEV = 5.0  # degrees from 90; worse => line-fit was dragged, use the box
MIN_AREA_FRAC = 0.004
KEEP_VS_MAX = 0.25
PAD_FRAC = 0.002
PASS_SCORE = 0.45  # QC gate on the outcome score
BIREFNET_PAD = 0.12  # replicate-border padding before segmentation

# Raw card and measured graded-slab aspect targets for the outcome score.
PLAUSIBLE_ASPECTS = (CARD_ASPECT, 0.585)

# Measured graded-slab aspect cluster — unsnapped quads inside this window
# still pass the QC gate.
SLAB_WINDOW = (0.573, 0.597)

DEFAULT_REMBG_MODEL = "birefnet-general"
OUTPUT_JPEG_QUALITY = 92

# ── BiRefNet session (lazy, cached, injectable for tests) ───────────────────

_session: Any = None
_session_lock = threading.Lock()

# Only the BiRefNet family may be selected. rembg also ships session classes
# that POST the image to third-party APIs (e.g. "withoutbg") — an env-var
# typo must never be able to route user card photos off-box.
ALLOWED_REMBG_MODELS = frozenset({"birefnet-general", "birefnet-general-lite"})


def _get_session() -> Any:
    """Create (once) and return the rembg/BiRefNet session.

    Model name is read from `REMBG_MODEL` at first use so tests and deploys
    can steer it without re-importing; it must be in ALLOWED_REMBG_MODELS.
    The session is cached for the container's lifetime behind a lock — three
    concurrent cold requests must not each construct a ~930MB ONNX session.
    In Cloud Run the weights are baked into the image (`U2NET_HOME`), so
    this never downloads at runtime.
    """
    global _session
    if _session is None:
        with _session_lock:
            if _session is None:
                import onnxruntime as ort
                from rembg import new_session

                model = os.environ.get("REMBG_MODEL", DEFAULT_REMBG_MODEL)
                if model not in ALLOWED_REMBG_MODELS:
                    raise ValueError(
                        f"REMBG_MODEL {model!r} is not allowed; "
                        f"choose one of {sorted(ALLOWED_REMBG_MODELS)}"
                    )
                # ORT's CPU memory arena retains every inference's peak
                # allocation for the process lifetime — measured ~8GB
                # resident after ONE warmed BiRefNet pass, which OOM-killed
                # an 8Gi Cloud Run container on its first real request.
                # Without the arena, activations are freed after each run;
                # steady state drops to weights + overhead at a small
                # per-request allocation cost.
                sess_opts = ort.SessionOptions()
                sess_opts.enable_cpu_mem_arena = False
                logger.info("loading BiRefNet session %s (cpu_mem_arena off)", model)
                _session = new_session(model, sess_opts=sess_opts)
                logger.info("BiRefNet session ready")
    return _session


def warm_up() -> None:
    """Load the session and run one tiny inference at container startup.

    The first real request must pay neither the ~930MB model load (plus
    pooch's full-file hash pass) nor ORT's first-run allocations — cold,
    those pushed a /process call past the smoke test's 120s timeout.
    Called from the service startup hook, gated on REQUIRE_BAKED_WEIGHTS;
    unit tests never reach it.
    """
    import rembg

    session = _get_session()
    dummy = np.zeros((64, 64, 3), np.uint8)
    rembg.remove(dummy, session=session)


def is_session_loaded() -> bool:
    """Cheap, side-effect-free check: is the BiRefNet session already resident?

    True once `_get_session()` (via a crop or `warm_up()`) has constructed and
    cached the session for this process. Lets a repeat warm-up short-circuit —
    no reload, no inference — instead of paying even a tiny dummy pass again.
    """
    return _session is not None


# ── Input ───────────────────────────────────────────────────────────────────


def _load(image_bytes: bytes) -> tuple[np.ndarray, np.ndarray, float]:
    """Decode to BGR and build the detection-resolution copy.

    Returns `(full, work, scale)` where `work = full × scale` (longest edge
    capped at WORK_LONG) and `scale` is 1.0 when no resize happened.
    Dividing work-space coordinates by `scale` maps back to `full` — final
    crop pixels are always taken from `full`.
    """
    im = ImageOps.exif_transpose(Image.open(BytesIO(image_bytes))).convert("RGB")
    full = cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)
    h, w = full.shape[:2]
    scale = WORK_LONG / max(h, w)
    if scale < 1:
        work = cv2.resize(full, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
        return full, work, scale
    return full, full.copy(), 1.0


def border_bg_lab(work_lab: np.ndarray, frac: float = 0.03) -> np.ndarray:
    """Median LAB color of the image's border ring — the background estimate."""
    h, w = work_lab.shape[:2]
    t = max(2, int(frac * min(h, w)))
    ring = np.concatenate(
        [
            work_lab[:t].reshape(-1, 3),
            work_lab[-t:].reshape(-1, 3),
            work_lab[:, :t].reshape(-1, 3),
            work_lab[:, -t:].reshape(-1, 3),
        ]
    )
    return np.median(ring, axis=0)


# ── Mask candidates ─────────────────────────────────────────────────────────


def _bg_distance_mask(work: np.ndarray, l_weight: float) -> np.ndarray | None:
    """Threshold on LAB distance from the border-estimated background color.

    Two L-weights are tried by `classical_candidates`: 0.5 discounts
    luminance (shadow tolerance), 1.0 keeps it (separates a card that
    matches the background's chroma but not its brightness).
    """
    lab = cv2.cvtColor(work, cv2.COLOR_BGR2LAB).astype(np.float32)
    bg = border_bg_lab(lab)
    d = lab - bg
    dist = np.sqrt((l_weight * d[..., 0]) ** 2 + d[..., 1] ** 2 + d[..., 2] ** 2)
    dist8 = np.clip(dist, 0, 255).astype(np.uint8)
    thr, mask = cv2.threshold(dist8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if thr < 6:
        return None
    k9 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    k5 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k9)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k5)
    return mask


def _edge_mask(work: np.ndarray) -> np.ndarray | None:
    """Canny edges → filled convex hulls of large contours."""
    g = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
    g = cv2.createCLAHE(2.0, (8, 8)).apply(g)
    g = cv2.GaussianBlur(g, (5, 5), 0)
    e = cv2.Canny(g, 12, 45)
    e = cv2.dilate(e, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    cnts, _ = cv2.findContours(e, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    mask = np.zeros(g.shape, np.uint8)
    frame = g.shape[0] * g.shape[1]
    for c in cnts:
        hull = cv2.convexHull(c)
        if cv2.contourArea(hull) > 0.02 * frame:
            cv2.drawContours(mask, [hull], -1, 255, -1)
    return mask if mask.any() else None


def classical_candidates(work: np.ndarray) -> list[np.ndarray]:
    return [
        m
        for m in (
            _bg_distance_mask(work, 0.5),
            _bg_distance_mask(work, 1.0),
            _edge_mask(work),
        )
        if m is not None
    ]


def birefnet_mask(work: np.ndarray) -> np.ndarray:
    """BiRefNet alpha matte → binary mask, at work resolution.

    The input is padded with the measured background color (BORDER_CONSTANT)
    before segmentation so a frame-filling card reads as an object on a
    background rather than "the whole image".
    """
    from rembg import remove

    h, w = work.shape[:2]
    p = int(BIREFNET_PAD * max(h, w))
    t = max(2, int(0.03 * min(h, w)))
    ring = np.concatenate(
        [
            work[:t].reshape(-1, 3),
            work[-t:].reshape(-1, 3),
            work[:, :t].reshape(-1, 3),
            work[:, -t:].reshape(-1, 3),
        ]
    )
    bg_bgr = tuple(int(v) for v in np.median(ring, axis=0))
    padded = cv2.copyMakeBorder(work, p, p, p, p, cv2.BORDER_CONSTANT, value=bg_bgr)
    rgba = remove(cv2.cvtColor(padded, cv2.COLOR_BGR2RGB), session=_get_session())
    alpha = np.array(rgba)[..., 3][p : p + h, p : p + w]
    mask = (alpha > 25).astype(np.uint8) * 255
    k5 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k5)


# ── Components ──────────────────────────────────────────────────────────────


def components(mask: np.ndarray, frame_area: float) -> list[np.ndarray]:
    """Connected components of `mask`, largest first, small/relative-noise dropped."""
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    areas = [(stats[i, cv2.CC_STAT_AREA], i) for i in range(1, n)]
    if not areas:
        return []
    amax = max(a for a, _ in areas)
    out = []
    for a, i in sorted(areas, reverse=True):
        if a < MIN_AREA_FRAC * frame_area or a < KEEP_VS_MAX * amax:
            continue
        comp = (labels == i).astype(np.uint8) * 255
        cnts, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        out.append(max(cnts, key=cv2.contourArea))
    return out


def merge_components(cnts: list[np.ndarray], work_shape: tuple) -> list[np.ndarray]:
    """Union-find on padded bounding boxes — close fragments become one card."""
    if len(cnts) < 2:
        return cnts
    margin = int(0.02 * max(work_shape[:2]))
    boxes = [cv2.boundingRect(c) for c in cnts]
    parent = list(range(len(cnts)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def touch(a: int, b: int) -> bool:
        ax, ay, aw, ah = boxes[a]
        bx, by, bw, bh = boxes[b]
        return not (
            ax + aw + margin < bx
            or bx + bw + margin < ax
            or ay + ah + margin < by
            or by + bh + margin < ay
        )

    for i in range(len(cnts)):
        for j in range(i + 1, len(cnts)):
            if touch(i, j):
                parent[find(i)] = find(j)
    groups: dict[int, list[np.ndarray]] = {}
    for i, c in enumerate(cnts):
        groups.setdefault(find(i), []).append(c)
    return [g[0] if len(g) == 1 else np.vstack(g) for g in groups.values()]


# ── Geometry ────────────────────────────────────────────────────────────────


def _intersect(p0, d0, p1, d1) -> np.ndarray:
    coeffs = np.array([[d0[0], -d1[0]], [d0[1], -d1[1]]], dtype=np.float64)
    rhs = np.array([p1[0] - p0[0], p1[1] - p0[1]], dtype=np.float64)
    t = np.linalg.solve(coeffs, rhs)
    return np.array([p0[0] + t[0] * d0[0], p0[1] + t[0] * d0[1]])


def line_fit_quad(hull: np.ndarray, rect: tuple) -> tuple[np.ndarray, float]:
    """Fit one line per oriented-box side to the hull points; intersect corners.

    Cards are rectangles: if a resulting corner is far from 90 degrees, a
    fitted line was dragged (shadow, glare) — fall back to the oriented box,
    which cannot shear.
    """
    box = cv2.boxPoints(rect)
    pts = hull.reshape(-1, 2).astype(np.float64)
    band = max(3.0, 0.05 * min(rect[1]))
    lines, resid = [], []
    for i in range(4):
        p0, p1 = box[i], box[(i + 1) % 4]
        v = p1 - p0
        seg_len = np.linalg.norm(v)
        u = v / seg_len
        d = np.abs((pts[:, 0] - p0[0]) * u[1] - (pts[:, 1] - p0[1]) * u[0])
        t = (pts - p0) @ u
        sel = pts[(d < band) & (t > -0.05 * seg_len) & (t < 1.05 * seg_len)]
        if len(sel) < 2:
            lines.append((p0.astype(np.float64), u.astype(np.float64)))
            resid.append(band)
            continue
        fit = cv2.fitLine(sel.astype(np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01)
        vx, vy, x0, y0 = fit.flatten()
        dd = np.abs((sel[:, 0] - x0) * vy - (sel[:, 1] - y0) * vx)
        resid.append(float(np.mean(dd)))
        lines.append((np.array([x0, y0]), np.array([vx, vy])))
    quad = np.array(
        [_intersect(*lines[i], *lines[(i + 1) % 4]) for i in range(4)], dtype=np.float64
    )
    for i in range(4):
        a, b, c = quad[(i - 1) % 4], quad[i], quad[(i + 1) % 4]
        v1, v2 = a - b, c - b
        cosang = np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-9)
        ang = math.degrees(math.acos(np.clip(cosang, -1, 1)))
        if abs(ang - 90) > MAX_CORNER_DEV:
            return box.astype(np.float64), float(np.mean(resid))
    return quad, float(np.mean(resid))


def order_quad(quad: np.ndarray) -> np.ndarray:
    c = quad.mean(axis=0)
    ang = np.arctan2(quad[:, 1] - c[1], quad[:, 0] - c[0])
    quad = quad[np.argsort(ang)]
    s = quad.sum(axis=1)
    return np.roll(quad, -int(np.argmin(s)), axis=0)


def expand_quad(quad: np.ndarray, pad: float) -> np.ndarray:
    c = quad.mean(axis=0)
    v = quad - c
    n = np.linalg.norm(v, axis=1, keepdims=True)
    return quad + v / n * pad


def warp_rect_card(
    img: np.ndarray, quad_img: np.ndarray, pad: float
) -> tuple[np.ndarray, float, bool]:
    """One perspective warp from the quad to an axis-aligned card.

    When the measured aspect is within ASPECT_SNAP of 2.5:3.5 the target is
    snapped to exactly that ratio (deskew must not invent a new aspect).
    """
    quad = order_quad(quad_img)
    quad = expand_quad(quad, pad)
    w1 = np.linalg.norm(quad[1] - quad[0])
    w2 = np.linalg.norm(quad[2] - quad[3])
    h1 = np.linalg.norm(quad[3] - quad[0])
    h2 = np.linalg.norm(quad[2] - quad[1])
    w, h = (w1 + w2) / 2, (h1 + h2) / 2
    long_e, short_e = max(w, h), min(w, h)
    aspect = float(short_e / long_e)
    snapped = abs(aspect - CARD_ASPECT) <= ASPECT_SNAP
    if snapped:
        short_e = long_e * CARD_ASPECT
    tw, th = (short_e, long_e) if h >= w else (long_e, short_e)
    tw, th = max(8, int(round(tw))), max(8, int(round(th)))
    dst = np.array([[0, 0], [tw - 1, 0], [tw - 1, th - 1], [0, th - 1]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(quad.astype(np.float32), dst)
    crop = cv2.warpPerspective(img, matrix, (tw, th), flags=cv2.INTER_CUBIC)
    return crop, aspect, snapped


def crop_oriented_rect(img: np.ndarray, rect_img: tuple, pad: float) -> np.ndarray:
    """Affine crop to the oriented rect — shape-preserving (die-cut route)."""
    (cx, cy), (w, h), ang = rect_img
    w, h = w + 2 * pad, h + 2 * pad
    matrix = cv2.getRotationMatrix2D((cx, cy), ang, 1.0)
    matrix[0, 2] += w / 2 - cx
    matrix[1, 2] += h / 2 - cy
    return cv2.warpAffine(img, matrix, (int(round(w)), int(round(h))), flags=cv2.INTER_CUBIC)


def frame_echo(rect: tuple, work_shape: tuple) -> bool:
    """A detection that is just the image frame handed back to us."""
    h, w = work_shape[:2]
    if rect[1][0] * rect[1][1] < 0.90 * w * h:
        return False
    m = 0.02 * max(h, w)
    box = cv2.boxPoints(rect)
    return all(min(x, w - x) < m or min(y, h - y) < m for x, y in box)


# ── Scoring ─────────────────────────────────────────────────────────────────


def _aspect_score(aspect: float) -> float:
    return max(math.exp(-(((aspect - t) / 0.06) ** 2)) for t in PLAUSIBLE_ASPECTS)


def bg_residual(crop: np.ndarray, bg_lab: np.ndarray) -> float:
    """Fraction of the crop's border ring still background-colored.

    The outcome-based score: a correct crop's ring is card, not background.
    """
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB).astype(np.float32)
    h, w = lab.shape[:2]
    t = max(2, int(0.02 * min(h, w)))
    ring = np.concatenate(
        [
            lab[:t].reshape(-1, 3),
            lab[-t:].reshape(-1, 3),
            lab[:, :t].reshape(-1, 3),
            lab[:, -t:].reshape(-1, 3),
        ]
    )
    d = ring - bg_lab
    dist = np.sqrt((0.5 * d[:, 0]) ** 2 + d[:, 1] ** 2 + d[:, 2] ** 2)
    return float(np.mean(dist < 12))


def analyze(mask: np.ndarray, work: np.ndarray, bg: np.ndarray) -> list[dict[str, Any]]:
    """Geometry + outcome score for every component, at work resolution."""
    frame_area = work.shape[0] * work.shape[1]
    cnts = merge_components(components(mask, frame_area), work.shape)
    out: list[dict[str, Any]] = []
    for cnt in cnts:
        hull = cv2.convexHull(cnt)
        rect = cv2.minAreaRect(hull)
        if min(rect[1]) < 8:
            continue
        echo = frame_echo(rect, work.shape)
        rectangularity = cv2.contourArea(hull) / max(1.0, rect[1][0] * rect[1][1])
        if rectangularity >= RECT_MIN:
            quad, res = line_fit_quad(hull, rect)
            crop_w, aspect, snapped = warp_rect_card(work, quad, 1.0)
            geom: dict[str, Any] = {"route": "quad", "quad": quad, "rect": rect}
        else:
            crop_w = crop_oriented_rect(work, rect, 1.0)
            h, w = crop_w.shape[:2]
            aspect, snapped, res = min(w, h) / max(w, h), False, -1.0
            geom = {"route": "diecut", "quad": None, "rect": rect}
        bgres = bg_residual(crop_w, bg)
        score = rectangularity * _aspect_score(aspect) * (1.0 - 0.7 * bgres)
        if echo:  # frame-shaped detection: keep as last resort, never auto-pass
            score *= 0.4
        out.append(
            {
                **geom,
                "hull": hull,
                "rectangularity": round(rectangularity, 3),
                "aspect": round(aspect, 4),
                "aspect_dev": round(abs(aspect - CARD_ASPECT), 4),
                "snapped": snapped,
                "fit_resid": round(res, 2),
                "bg_residual": round(bgres, 3),
                "frame_echo": echo,
                "score": round(score, 3),
            }
        )
    return out


def final_crop(full: np.ndarray, scale: float, comp: dict[str, Any], pad: float) -> np.ndarray:
    """Crop the FULL-resolution original along the work-space detection."""
    if comp["route"] == "quad":
        crop, _, _ = warp_rect_card(full, comp["quad"] / scale, pad)
    else:
        r = comp["rect"]
        rect_full = (
            (r[0][0] / scale, r[0][1] / scale),
            (r[1][0] / scale, r[1][1] / scale),
            r[2],
        )
        crop = crop_oriented_rect(full, rect_full, pad)
    if crop.shape[0] < crop.shape[1]:
        crop = cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return crop


# ── Pre-cropped identity guard ──────────────────────────────────────────────


def margin_is_background(
    comp: dict[str, Any], work: np.ndarray, lab_work: np.ndarray, bg: np.ndarray
) -> bool:
    """Is everything OUTSIDE the detected card uniform background?

    If the margin contains structure (e.g. the card's own border), cropping
    would eat the card.
    """
    m = np.zeros(work.shape[:2], np.uint8)
    cv2.drawContours(m, [comp["hull"].astype(np.int32)], -1, 255, -1)
    m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11)))
    outside = lab_work[m == 0]
    if len(outside) < 500:
        return True
    d = outside - bg
    dist = np.sqrt((0.5 * d[:, 0]) ** 2 + d[:, 1] ** 2 + d[:, 2] ** 2)
    return float(np.mean(dist < 14)) > 0.90 and float(outside.std(axis=0).mean()) < 9.0


def should_identity(
    comps: list[dict[str, Any]], work: np.ndarray, lab_work: np.ndarray, bg: np.ndarray
) -> tuple[bool, str]:
    """Card-aspect frames are probably pre-cropped: identity unless there is
    strong, well-separated evidence of a smaller card inside.

    Returns (identity?, reason): reason 'frame' means the detection IS the
    frame (settled — do not bother a second tier); 'weak'/'margin' mean the
    evidence just wasn't good enough — a better mask source may still
    justify a crop.
    """
    frame_area = work.shape[0] * work.shape[1]
    if not comps:
        return True, "weak"
    top = max(comps, key=lambda c: c["score"])
    if top["rect"][1][0] * top["rect"][1][1] >= 0.92 * frame_area:
        return True, "frame"
    strong = top["route"] == "quad" and top["rectangularity"] >= 0.95 and top["score"] >= PASS_SCORE
    if not strong:
        return True, "weak"
    if not margin_is_background(top, work, lab_work, bg):
        return True, "margin"
    return False, ""


# ── QC gate ─────────────────────────────────────────────────────────────────


def passes(c: dict[str, Any]) -> bool:
    """Quality gate: does this component look like a correct, unshaved crop?"""
    if c["frame_echo"] or c["score"] < PASS_SCORE:
        return False
    if c["route"] == "quad":
        return c["snapped"] or SLAB_WINDOW[0] <= c["aspect"] <= SLAB_WINDOW[1]
    return c["rectangularity"] >= 0.80 and c["aspect_dev"] <= 0.05


# ── Pipeline ────────────────────────────────────────────────────────────────


def _run_classical(work: np.ndarray, bg: np.ndarray) -> list[dict[str, Any]]:
    """Analyze every classical mask candidate; keep the best-scoring set."""
    best: list[dict[str, Any]] = []
    best_score = -1.0
    for m in classical_candidates(work):
        comps = analyze(m, work, bg)
        s = max((c["score"] for c in comps), default=0.0)
        if s > best_score:
            best, best_score = comps, s
    return best


def _run_tiered(
    image_bytes: bytes, full: np.ndarray, work: np.ndarray, scale: float
) -> bytes | None:
    """The tiered pipeline on decoded images.

    Returns JPEG bytes of the best crop, the untouched `image_bytes` when the
    identity guard fires (the input already IS the card), or None to decline.
    """
    lab_work = cv2.cvtColor(work, cv2.COLOR_BGR2LAB).astype(np.float32)
    bg = border_bg_lab(lab_work)
    pad = max(2.0, PAD_FRAC * max(full.shape[:2]))
    fh, fw = work.shape[:2]
    near_card_frame = abs(min(fh, fw) / max(fh, fw) - CARD_ASPECT) <= FRAME_CARD_WINDOW

    comps = _run_classical(work, bg)
    tier = "classical"
    if near_card_frame:
        # Classical evidence alone never settles identity (its frame-sized
        # detections are echo artifacts) — BiRefNet gets the deciding vote.
        if should_identity(comps, work, lab_work, bg)[0]:
            comps = analyze(birefnet_mask(work), work, bg)
            tier = "birefnet"
            if should_identity(comps, work, lab_work, bg)[0]:
                logger.info("tiered: identity (card-aspect frame), returning input untouched")
                return image_bytes
    if tier == "classical" and not any(passes(c) for c in comps):
        comps = analyze(birefnet_mask(work), work, bg)
        tier = "birefnet"
        if near_card_frame and should_identity(comps, work, lab_work, bg)[0]:
            logger.info("tiered: identity after birefnet fallback, returning input untouched")
            return image_bytes
    elif tier == "classical" and comps:
        # Verify: a color-blind method can lock onto an inner boundary when
        # the card border matches the background (dark-on-dark). If the
        # semantic mask sees a materially larger card that itself passes
        # the gate, classical shaved the border — take the bigger truth.
        def _area(c: dict[str, Any]) -> float:
            return c["rect"][1][0] * c["rect"][1][1]

        c_top = max((c for c in comps if passes(c)), key=_area)
        b_comps = analyze(birefnet_mask(work), work, bg)
        b_pass = [c for c in b_comps if passes(c)]
        if b_pass:
            b_top = max(b_pass, key=_area)
            if _area(b_top) > 1.06 * _area(c_top):
                comps, tier = b_comps, "birefnet-verify"

    winners = [c for c in comps if passes(c)]
    if not winners:
        logger.info("tiered: no component passed the QC gate (tier=%s), declining", tier)
        return None
    best = max(winners, key=lambda c: c["score"])
    crop = final_crop(full, scale, best, pad)
    logger.info(
        "tiered: tier=%s route=%s score=%.3f aspect=%.4f snapped=%s",
        tier,
        best["route"],
        best["score"],
        best["aspect"],
        best["snapped"],
    )
    ok, buf = cv2.imencode(".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), OUTPUT_JPEG_QUALITY])
    if not ok:
        raise RuntimeError("cv2.imencode failed")
    return bytes(buf)


# ── Public API ──────────────────────────────────────────────────────────────


def tiered_crop(image_bytes: bytes) -> bytes | None:
    """Tiered-crop an image.

    Returns JPEG bytes of the single best QC-gate-passing card crop, taken
    from the full-resolution original. When the identity guard fires (the
    input already looks like the card) it returns `image_bytes` untouched —
    a card-aspect frame always clears the cascade's gates, so that ends the
    cascade with the input as the result. Returns None to decline:
    unreadable input, or nothing passed the QC gate. The cascade applies
    its own validator + text gates on top of any bytes returned here.
    """
    try:
        full, work, scale = _load(image_bytes)
    except Exception as exc:  # noqa: BLE001
        logger.warning("tiered_crop: cannot open image: %s", exc)
        return None

    try:
        return _run_tiered(image_bytes, full, work, scale)
    except Exception:
        logger.exception("tiered_crop: pipeline failed")
        return None


# ── NEO-173 crop fast-path ───────────────────────────────────────────────────


def fast_tiered_crop(image_bytes: bytes) -> bytes | None:
    """Classical-only fast path (NO BiRefNet / torch): the ~35s-BiRefNet skip.

    Returns the input bytes UNTOUCHED when the image is an unambiguous
    pre-cropped card-aspect frame — the "identity" outcome — and `None` to
    tell the caller it must ESCALATE to the full `tiered_crop` (BiRefNet)
    pipeline. `None` is deliberately the only non-accept signal: this
    function NEVER produces a new crop, so a caller that gets `None` runs the
    complete, unchanged pipeline and cannot end up with a worse crop than
    `strong` mode would have produced.

    Why identity-only. The live scanner majority (~80% of images) is already
    a tight card-aspect frame; the full pipeline confirms that by paying a
    ~35s BiRefNet pass whose only job is to re-affirm "yes, already a card"
    (measured: 479/596 corpus images are `identity`, avg 35.7s each). That
    pass is the waste this path removes. We accept identity here ONLY on the
    `should_identity` "frame" verdict — the top classical component fills the
    card-aspect frame — which that function's own contract calls "settled —
    do not bother a second tier". Validated 284/284 correct against the
    BiRefNet ground truth on the corpus's identity set.

    Why NOT a classical crop fast-accept. A classical crop cannot be trusted
    without the pipeline's BiRefNet *verification* stage: a border-shave
    (dark-on-dark charcoal borders, white-on-white) warps to a clean card
    aspect and passes every classical gate — QC score, rectangularity,
    axis-alignment, uniform-margin — while quietly clipping the card. The
    corpus's `2026-08-11-0083` (charcoal border on a dark belt) and the
    `tc52r` white-border set both do exactly this; only BiRefNet seeing a
    materially larger card recovers the border. So EVERY crop escalates
    (see NEO-173 validation notes), which also means any image needing
    deskew/rotation reaches the full deskew path untouched — the fast path
    never emits a crop at all, let alone an un-deskewed one.
    """
    try:
        full, work, scale = _load(image_bytes)
    except Exception as exc:  # noqa: BLE001
        logger.warning("fast_tiered_crop: cannot open image: %s", exc)
        return None  # escalate; the full pipeline owns the undecodable path

    try:
        fh, fw = work.shape[:2]
        near_card_frame = abs(min(fh, fw) / max(fh, fw) - CARD_ASPECT) <= FRAME_CARD_WINDOW
        if not near_card_frame:
            # A frame that is not itself card-aspect is never a pre-cropped
            # card handed back to us — it is a photo with framing to remove.
            logger.info("fast: escalate (frame not card-aspect)")
            return None

        lab_work = cv2.cvtColor(work, cv2.COLOR_BGR2LAB).astype(np.float32)
        bg = border_bg_lab(lab_work)
        comps = _run_classical(work, bg)
        identity, reason = should_identity(comps, work, lab_work, bg)
        # Only the "frame" verdict is classically settled. "weak"/"margin"
        # mean a better (semantic) mask might still justify a crop — exactly
        # what BiRefNet is for — so those escalate rather than pass through.
        if identity and reason == "frame":
            logger.info("fast: identity (frame-fill card-aspect frame), skipping BiRefNet")
            return image_bytes
        logger.info("fast: escalate (identity=%s reason=%s)", identity, reason)
        return None
    except Exception:
        logger.exception("fast_tiered_crop: classical pass failed; escalating")
        return None
