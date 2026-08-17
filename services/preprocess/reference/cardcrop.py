# Benchmark harness for the NEO-161 tiered crop pipeline - PORT REFERENCE.
# Human-verified 29/29 on the stress corpus (4 review rounds, 2026-08-16).
# This file is the source of truth for the port into app/cropper/tiered.py;
# it is removed once the port lands.
"""Benchmark harness v4: find card(s) in an image, deskew, crop tight.

v4 (after human review of v3 output): card-aspect input frames default to
identity passthrough (pre-cropped inputs must not be re-cropped); quads with a
corner far from 90 degrees fall back to the oriented box; aspect-snap tightened.

Mask sources share one geometry stage:
  classical  - multiple candidate masks (bg-color distance half/full L, Canny),
               each scored by the OUTCOME of its provisional work-res crop
  birefnet   - rembg/BiRefNet alpha matte on a border-padded input (padding makes
               a frame-filling card an "object on background" again)
  tiered     - classical first; components failing the QC gate re-run via birefnet

Geometry: components -> merge close fragments -> hull -> minAreaRect
  rectangular (hull/rect >= RECT_MIN) -> 4-line-fit corners -> one warpPerspective
  else (die-cut etc.)                 -> affine to the oriented rect, keep shape
Frame-filling detections are rejected (frame echo). Final pixels always come
from the full-resolution original.
"""
import os, sys, csv, time, math
import numpy as np
import cv2
from PIL import Image, ImageOps

WORK_LONG = 1200
RECT_MIN = 0.92
CARD_ASPECT = 2.5 / 3.5
ASPECT_SNAP = 0.020
FRAME_CARD_WINDOW = 0.030   # input frame aspect this close to 2.5:3.5 => likely pre-cropped
MAX_CORNER_DEV = 5.0        # degrees from 90; worse => line-fit was dragged, use the box
MIN_AREA_FRAC = 0.004
KEEP_VS_MAX = 0.25
PAD_FRAC = 0.002
PASS_SCORE = 0.45          # QC gate on the outcome score
BIREFNET_PAD = 0.12        # replicate-border padding before segmentation


# ---------- input ----------

def load(path):
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    full = cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)
    h, w = full.shape[:2]
    scale = WORK_LONG / max(h, w)
    work = cv2.resize(full, (round(w * scale), round(h * scale)),
                      interpolation=cv2.INTER_AREA) if scale < 1 else full.copy()
    return full, work, (scale if scale < 1 else 1.0)


def border_bg_lab(work_lab, frac=0.03):
    h, w = work_lab.shape[:2]
    t = max(2, int(frac * min(h, w)))
    ring = np.concatenate([
        work_lab[:t].reshape(-1, 3), work_lab[-t:].reshape(-1, 3),
        work_lab[:, :t].reshape(-1, 3), work_lab[:, -t:].reshape(-1, 3)])
    return np.median(ring, axis=0)


# ---------- mask candidates ----------

def _bg_distance_mask(work, l_weight):
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


def _edge_mask(work):
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


def classical_candidates(work):
    return [m for m in (_bg_distance_mask(work, 0.5),
                        _bg_distance_mask(work, 1.0),
                        _edge_mask(work)) if m is not None]


def birefnet_mask(work, session):
    from rembg import remove
    h, w = work.shape[:2]
    p = int(BIREFNET_PAD * max(h, w))
    t = max(2, int(0.03 * min(h, w)))
    ring = np.concatenate([work[:t].reshape(-1, 3), work[-t:].reshape(-1, 3),
                           work[:, :t].reshape(-1, 3), work[:, -t:].reshape(-1, 3)])
    bg_bgr = tuple(int(v) for v in np.median(ring, axis=0))
    padded = cv2.copyMakeBorder(work, p, p, p, p, cv2.BORDER_CONSTANT,
                                value=bg_bgr)
    rgba = remove(cv2.cvtColor(padded, cv2.COLOR_BGR2RGB), session=session)
    alpha = np.array(rgba)[..., 3][p:p + h, p:p + w]
    mask = (alpha > 25).astype(np.uint8) * 255
    k5 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k5)


# ---------- components ----------

def components(mask, frame_area):
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


def merge_components(cnts, work_shape):
    if len(cnts) < 2:
        return cnts
    margin = int(0.02 * max(work_shape[:2]))
    boxes = [cv2.boundingRect(c) for c in cnts]
    parent = list(range(len(cnts)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def touch(a, b):
        ax, ay, aw, ah = boxes[a]
        bx, by, bw, bh = boxes[b]
        return not (ax + aw + margin < bx or bx + bw + margin < ax or
                    ay + ah + margin < by or by + bh + margin < ay)

    for i in range(len(cnts)):
        for j in range(i + 1, len(cnts)):
            if touch(i, j):
                parent[find(i)] = find(j)
    groups = {}
    for i, c in enumerate(cnts):
        groups.setdefault(find(i), []).append(c)
    return [g[0] if len(g) == 1 else np.vstack(g) for g in groups.values()]


# ---------- geometry ----------

def _intersect(p0, d0, p1, d1):
    A = np.array([[d0[0], -d1[0]], [d0[1], -d1[1]]], dtype=np.float64)
    b = np.array([p1[0] - p0[0], p1[1] - p0[1]], dtype=np.float64)
    t = np.linalg.solve(A, b)
    return np.array([p0[0] + t[0] * d0[0], p0[1] + t[0] * d0[1]])


def line_fit_quad(hull, rect):
    box = cv2.boxPoints(rect)
    pts = hull.reshape(-1, 2).astype(np.float64)
    band = max(3.0, 0.05 * min(rect[1]))
    lines, resid = [], []
    for i in range(4):
        p0, p1 = box[i], box[(i + 1) % 4]
        v = p1 - p0
        L = np.linalg.norm(v)
        u = v / L
        d = np.abs((pts[:, 0] - p0[0]) * u[1] - (pts[:, 1] - p0[1]) * u[0])
        t = (pts - p0) @ u
        sel = pts[(d < band) & (t > -0.05 * L) & (t < 1.05 * L)]
        if len(sel) < 2:
            lines.append((p0.astype(np.float64), u.astype(np.float64)))
            resid.append(band)
            continue
        vx, vy, x0, y0 = cv2.fitLine(sel.astype(np.float32),
                                     cv2.DIST_HUBER, 0, 0.01, 0.01).flatten()
        dd = np.abs((sel[:, 0] - x0) * vy - (sel[:, 1] - y0) * vx)
        resid.append(float(np.mean(dd)))
        lines.append((np.array([x0, y0]), np.array([vx, vy])))
    quad = np.array([_intersect(*lines[i], *lines[(i + 1) % 4]) for i in range(4)],
                    dtype=np.float64)
    # cards are rectangles: if a corner is far from 90 degrees, a fitted line was
    # dragged (shadow, glare) - fall back to the oriented box, which cannot shear
    for i in range(4):
        a, b, c = quad[(i - 1) % 4], quad[i], quad[(i + 1) % 4]
        v1, v2 = a - b, c - b
        cosang = np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-9)
        ang = math.degrees(math.acos(np.clip(cosang, -1, 1)))
        if abs(ang - 90) > MAX_CORNER_DEV:
            return box.astype(np.float64), float(np.mean(resid))
    return quad, float(np.mean(resid))


def order_quad(quad):
    c = quad.mean(axis=0)
    ang = np.arctan2(quad[:, 1] - c[1], quad[:, 0] - c[0])
    quad = quad[np.argsort(ang)]
    s = quad.sum(axis=1)
    return np.roll(quad, -int(np.argmin(s)), axis=0)


def expand_quad(quad, pad):
    c = quad.mean(axis=0)
    v = quad - c
    n = np.linalg.norm(v, axis=1, keepdims=True)
    return quad + v / n * pad


def warp_rect_card(img, quad_img, pad):
    quad = order_quad(quad_img)
    quad = expand_quad(quad, pad)
    w1 = np.linalg.norm(quad[1] - quad[0]); w2 = np.linalg.norm(quad[2] - quad[3])
    h1 = np.linalg.norm(quad[3] - quad[0]); h2 = np.linalg.norm(quad[2] - quad[1])
    w, h = (w1 + w2) / 2, (h1 + h2) / 2
    long_e, short_e = max(w, h), min(w, h)
    aspect = short_e / long_e
    snapped = abs(aspect - CARD_ASPECT) <= ASPECT_SNAP
    if snapped:
        short_e = long_e * CARD_ASPECT
    tw, th = (short_e, long_e) if h >= w else (long_e, short_e)
    tw, th = max(8, int(round(tw))), max(8, int(round(th)))
    dst = np.array([[0, 0], [tw - 1, 0], [tw - 1, th - 1], [0, th - 1]],
                   dtype=np.float32)
    M = cv2.getPerspectiveTransform(quad.astype(np.float32), dst)
    crop = cv2.warpPerspective(img, M, (tw, th), flags=cv2.INTER_CUBIC)
    return crop, aspect, snapped


def crop_oriented_rect(img, rect_img, pad):
    (cx, cy), (w, h), ang = rect_img
    w, h = w + 2 * pad, h + 2 * pad
    M = cv2.getRotationMatrix2D((cx, cy), ang, 1.0)
    M[0, 2] += w / 2 - cx
    M[1, 2] += h / 2 - cy
    return cv2.warpAffine(img, M, (int(round(w)), int(round(h))),
                          flags=cv2.INTER_CUBIC)


def frame_echo(rect, work_shape):
    """A detection that is just the image frame handed back to us."""
    h, w = work_shape[:2]
    if rect[1][0] * rect[1][1] < 0.90 * w * h:
        return False
    m = 0.02 * max(h, w)
    box = cv2.boxPoints(rect)
    return all(min(x, w - x) < m or min(y, h - y) < m for x, y in box)


# ---------- scoring ----------

PLAUSIBLE_ASPECTS = (CARD_ASPECT, 0.585)  # raw card, graded slab


def _aspect_score(aspect):
    return max(math.exp(-((aspect - t) / 0.06) ** 2) for t in PLAUSIBLE_ASPECTS)


def bg_residual(crop, bg_lab):
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB).astype(np.float32)
    h, w = lab.shape[:2]
    t = max(2, int(0.02 * min(h, w)))
    ring = np.concatenate([lab[:t].reshape(-1, 3), lab[-t:].reshape(-1, 3),
                           lab[:, :t].reshape(-1, 3), lab[:, -t:].reshape(-1, 3)])
    d = ring - bg_lab
    dist = np.sqrt((0.5 * d[:, 0]) ** 2 + d[:, 1] ** 2 + d[:, 2] ** 2)
    return float(np.mean(dist < 12))


def analyze(mask, work, bg):
    """Geometry + outcome score for every component, at work resolution."""
    frame_area = work.shape[0] * work.shape[1]
    cnts = merge_components(components(mask, frame_area), work.shape)
    out = []
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
            geom = dict(route="quad", quad=quad, rect=rect)
        else:
            crop_w = crop_oriented_rect(work, rect, 1.0)
            h, w = crop_w.shape[:2]
            aspect, snapped, res = min(w, h) / max(w, h), False, -1.0
            geom = dict(route="diecut", quad=None, rect=rect)
        bgres = bg_residual(crop_w, bg)
        score = rectangularity * _aspect_score(aspect) * (1.0 - 0.7 * bgres)
        if echo:  # frame-shaped detection: keep as last resort, never auto-pass
            score *= 0.4
        out.append(dict(**geom, hull=hull, rectangularity=round(rectangularity, 3),
                        aspect=round(aspect, 4),
                        aspect_dev=round(abs(aspect - CARD_ASPECT), 4),
                        snapped=snapped, fit_resid=round(res, 2),
                        bg_residual=round(bgres, 3), frame_echo=echo,
                        score=round(score, 3)))
    return out


def final_crop(full, scale, comp, pad):
    if comp["route"] == "quad":
        crop, _, _ = warp_rect_card(full, comp["quad"] / scale, pad)
    else:
        r = comp["rect"]
        rect_full = ((r[0][0] / scale, r[0][1] / scale),
                     (r[1][0] / scale, r[1][1] / scale), r[2])
        crop = crop_oriented_rect(full, rect_full, pad)
    if crop.shape[0] < crop.shape[1]:
        crop = cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return crop


# ---------- pre-cropped guard ----------

def margin_is_background(comp, work, lab_work, bg):
    """Is everything OUTSIDE the detected card uniform background? If the margin
    contains structure (e.g. the card's own border), cropping would eat the card."""
    m = np.zeros(work.shape[:2], np.uint8)
    cv2.drawContours(m, [comp["hull"].astype(np.int32)], -1, 255, -1)
    m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11)))
    outside = lab_work[m == 0]
    if len(outside) < 500:
        return True
    d = outside - bg
    dist = np.sqrt((0.5 * d[:, 0]) ** 2 + d[:, 1] ** 2 + d[:, 2] ** 2)
    return float(np.mean(dist < 14)) > 0.90 and float(outside.std(axis=0).mean()) < 9.0


def should_identity(comps, work, lab_work, bg):
    """Card-aspect frames are probably pre-cropped: identity unless there is
    strong, well-separated evidence of a smaller card inside.
    Returns (identity?, reason): reason 'frame' means the detection IS the frame
    (settled - do not bother a second tier); 'weak'/'margin' mean the evidence
    just wasn't good enough - a better mask source may still justify a crop."""
    frame_area = work.shape[0] * work.shape[1]
    if not comps:
        return True, "weak"
    top = max(comps, key=lambda c: c["score"])
    if top["rect"][1][0] * top["rect"][1][1] >= 0.92 * frame_area:
        return True, "frame"
    strong = (top["route"] == "quad" and top["rectangularity"] >= 0.95
              and top["score"] >= PASS_SCORE)
    if not strong:
        return True, "weak"
    if not margin_is_background(top, work, lab_work, bg):
        return True, "margin"
    return False, ""


# ---------- QC gate ----------

SLAB_WINDOW = (0.573, 0.597)  # measured graded-slab aspect cluster


def passes(c):
    """Quality gate: does this component look like a correct, unshaved crop?"""
    if c["frame_echo"] or c["score"] < PASS_SCORE:
        return False
    if c["route"] == "quad":
        return c["snapped"] or SLAB_WINDOW[0] <= c["aspect"] <= SLAB_WINDOW[1]
    return c["rectangularity"] >= 0.80 and c["aspect_dev"] <= 0.05


# ---------- pipeline ----------

def process(path, method, session=None):
    t0 = time.time()
    full, work, scale = load(path)
    lab_work = cv2.cvtColor(work, cv2.COLOR_BGR2LAB).astype(np.float32)
    bg = border_bg_lab(lab_work)
    pad = max(2.0, PAD_FRAC * max(full.shape[:2]))
    fh, fw = work.shape[:2]
    near_card_frame = abs(min(fh, fw) / max(fh, fw) - CARD_ASPECT) <= FRAME_CARD_WINDOW

    def identity_return(tier, t0):
        crop = full if full.shape[0] >= full.shape[1] else cv2.rotate(
            full, cv2.ROTATE_90_COUNTERCLOCKWISE)
        fa = min(fh, fw) / max(fh, fw)
        res = dict(route="identity", rectangularity=1.0, aspect=round(fa, 4),
                   aspect_dev=round(abs(fa - CARD_ASPECT), 4), snapped=False,
                   fit_resid=0.0, bg_residual=-1.0, score=1.0, verdict="pass",
                   tier=tier, crop=crop)
        return dict(status="ok", ms=int((time.time() - t0) * 1000),
                    results=[res], overlay=work.copy())

    def run_classical():
        best, best_score = [], -1.0
        for m in classical_candidates(work):
            comps = analyze(m, work, bg)
            s = max((c["score"] for c in comps), default=0.0)
            if s > best_score:
                best, best_score = comps, s
        return best

    if method == "classical":
        comps = run_classical()
        tier = "classical"
        if near_card_frame and should_identity(comps, work, lab_work, bg)[0]:
            return identity_return(tier, t0)
    elif method == "birefnet":
        comps = analyze(birefnet_mask(work, session), work, bg)
        tier = "birefnet"
        if near_card_frame and should_identity(comps, work, lab_work, bg)[0]:
            return identity_return(tier, t0)
    else:  # tiered
        comps = run_classical()
        tier = "classical"
        if near_card_frame:
            # classical evidence alone never settles identity (its frame-sized
            # detections are echo artifacts) - BiRefNet gets the deciding vote
            if should_identity(comps, work, lab_work, bg)[0]:
                comps = analyze(birefnet_mask(work, session), work, bg)
                tier = "birefnet"
                if should_identity(comps, work, lab_work, bg)[0]:
                    return identity_return(tier, t0)
        if tier == "classical" and not any(passes(c) for c in comps):
            comps = analyze(birefnet_mask(work, session), work, bg)
            tier = "birefnet"
            if near_card_frame and should_identity(comps, work, lab_work, bg)[0]:
                return identity_return(tier, t0)
        elif tier == "classical" and comps:
            # Verify: a color-blind method can lock onto an inner boundary when
            # the card border matches the background (dark-on-dark). If the
            # semantic mask sees a materially larger card that itself passes
            # the gate, classical shaved the border - take the bigger truth.
            def _area(c):
                return c["rect"][1][0] * c["rect"][1][1]
            c_top = max((c for c in comps if passes(c)), key=_area)
            b_comps = analyze(birefnet_mask(work, session), work, bg)
            b_pass = [c for c in b_comps if passes(c)]
            if b_pass:
                b_top = max(b_pass, key=_area)
                if _area(b_top) > 1.06 * _area(c_top):
                    comps, tier = b_comps, "birefnet-verify"

    overlay = work.copy()
    results = []
    for c in comps:
        color = (0, 80, 255) if c["route"] == "quad" else (255, 80, 0)
        pts = (c["quad"] if c["quad"] is not None
               else cv2.boxPoints(c["rect"])).astype(np.int32)
        cv2.polylines(overlay, [pts], True, color, 2)
        crop = final_crop(full, scale, c, pad)
        verdict = "pass" if passes(c) else "review"
        results.append(dict(route=c["route"], rectangularity=c["rectangularity"],
                            aspect=c["aspect"], aspect_dev=c["aspect_dev"],
                            snapped=c["snapped"], fit_resid=c["fit_resid"],
                            bg_residual=c["bg_residual"], score=c["score"],
                            verdict=verdict, tier=tier, crop=crop))
    return dict(status="ok" if results else "no_card",
                ms=int((time.time() - t0) * 1000), results=results, overlay=overlay)


def main(method, indir, outdir):
    os.makedirs(outdir, exist_ok=True)
    session = None
    if method in ("birefnet", "tiered"):
        from rembg import new_session
        session = new_session(os.environ.get("REMBG_MODEL", "birefnet-general"))
    rows = []
    files = sorted(f for f in os.listdir(indir) if f.lower().endswith(".jpg"))
    for f in files:
        r = process(os.path.join(indir, f), method, session)
        stem = os.path.splitext(f)[0]
        cv2.imwrite(os.path.join(outdir, f"{stem}__overlay.jpg"), r["overlay"],
                    [cv2.IMWRITE_JPEG_QUALITY, 82])
        for i, res in enumerate(r["results"]):
            cv2.imwrite(os.path.join(outdir, f"{stem}__crop{i}.jpg"),
                        res.pop("crop"), [cv2.IMWRITE_JPEG_QUALITY, 92])
            rows.append(dict(file=f, comp=i, status=r["status"], ms=r["ms"], **res))
        if not r["results"]:
            rows.append(dict(file=f, comp=-1, status=r["status"], ms=r["ms"]))
        print(f"{f}: {r['status']} n={len(r['results'])} {r['ms']}ms "
              f"tier={r['results'][0]['tier'] if r['results'] else '-'}", flush=True)
    with open(os.path.join(outdir, "metrics.csv"), "w", newline="") as fh:
        wr = csv.DictWriter(fh, fieldnames=["file", "comp", "status", "ms", "tier",
                                            "route", "rectangularity", "aspect",
                                            "aspect_dev", "snapped", "fit_resid",
                                            "bg_residual", "score", "verdict"])
        wr.writeheader()
        wr.writerows(rows)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
