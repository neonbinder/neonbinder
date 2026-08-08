"""SAM-based card crop — port of script-frontend's card_cropper_sam.py.

Semantic segmentation via HuggingFace's `facebook/sam-vit-base` (~375MB).
Handles dark-on-dark edges that defeat classical thresholding (pil_trim).
Runs CPU-only; no CUDA/MPS dependency.

Model is lazy-loaded on first call and cached for the lifetime of the
container. Subsequent calls reuse the in-memory model — the cold-start
cost is paid once per revision.

Public API: `sam_crop(image_bytes) -> bytes | None`. Returns JPEG bytes
of the rotated, axis-aligned crop, or None if no plausible card mask was
found.
"""

from __future__ import annotations

import logging
import os
import warnings
from typing import Any

import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

# ── Constants (mirror card_cropper_sam.py) ─────────────────────────────────

SAM_MODEL_ID = os.environ.get("SAM_MODEL_ID", "facebook/sam-vit-base")

CARD_ASPECT_PORTRAIT = 2.5 / 3.5
CARD_ASPECT_LANDSCAPE = 3.5 / 2.5

ASPECT_TOLERANCE = 0.22
MIN_AREA_FRACTION = 0.03
MAX_AREA_FRACTION = 0.97
MIN_SOLIDITY = 0.75
MIN_IOU_SCORE = 0.5

# Strategic probe points covering the center, quadrant centers, and mid-edge
# positions. 13 probes give SAM enough to find a card without the cost of a
# dense grid.
PROBE_POINTS_FRACTIONS = [
    (0.50, 0.50),
    (0.25, 0.25),
    (0.75, 0.25),
    (0.25, 0.75),
    (0.75, 0.75),
    (0.50, 0.25),
    (0.50, 0.75),
    (0.25, 0.50),
    (0.75, 0.50),
    (0.33, 0.33),
    (0.67, 0.33),
    (0.33, 0.67),
    (0.67, 0.67),
]

MAX_SAM_SIDE = 1500
CROP_PADDING_PX = 5
OUTPUT_JPEG_QUALITY = 92

# Suppress chatty import noise before torch/transformers land.
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
warnings.filterwarnings("ignore")

# ── Model cache ─────────────────────────────────────────────────────────────

_model: Any = None
_processor: Any = None


def _load_model() -> tuple[Any, Any]:
    """Load the SAM model and processor. Cached globally.

    First call takes ~5-15s on a warm Cloud Run container (weights from
    the image, no download). Subsequent calls return instantly.
    """
    global _model, _processor
    if _model is not None:
        return _model, _processor

    logger.info("loading SAM model %s", SAM_MODEL_ID)
    import torch

    torch.set_grad_enabled(False)
    torch.set_num_threads(1)

    import transformers

    transformers.logging.set_verbosity_error()
    from transformers import SamModel, SamProcessor

    _processor = SamProcessor.from_pretrained(SAM_MODEL_ID)
    _model = SamModel.from_pretrained(SAM_MODEL_ID)
    _model.eval()
    logger.info("SAM model ready")
    return _model, _processor


# ── Geometry + opencv helpers (port of card_cropper_utils) ─────────────────


def _compute_rotation_angle(pts: np.ndarray) -> tuple[float, Any]:
    """Compute the rotation needed to align the card with the axes.

    minAreaRect returns angle in (0, 90]; we normalize it based on which
    side of the rect is treated as "width" so the output angle rotates
    the card's long axis to vertical.
    """
    import cv2

    rect = cv2.minAreaRect(pts.astype(np.float32))
    rw, rh = rect[1]
    angle = rect[2]
    if rw == 0 or rh == 0:
        return 0.0, rect
    if rw > rh:
        return -(90.0 - angle), rect
    return -angle, rect


def _rotate_and_crop(
    image: np.ndarray,
    pts: np.ndarray,
    *,
    padding: int = CROP_PADDING_PX,
) -> tuple[np.ndarray, np.ndarray]:
    import cv2

    rotation_angle, _rect = _compute_rotation_angle(pts)

    img_h, img_w = image.shape[:2]
    cx, cy = img_w / 2.0, img_h / 2.0

    if abs(rotation_angle) > 0.5:
        rot_m = cv2.getRotationMatrix2D((cx, cy), rotation_angle, 1.0)
        cos_a = abs(rot_m[0, 0])
        sin_a = abs(rot_m[0, 1])
        new_w = int(img_h * sin_a + img_w * cos_a)
        new_h = int(img_h * cos_a + img_w * sin_a)
        rot_m[0, 2] += (new_w - img_w) / 2.0
        rot_m[1, 2] += (new_h - img_h) / 2.0
        rotated = cv2.warpAffine(
            image,
            rot_m,
            (new_w, new_h),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REPLICATE,
        )
        pts_h = np.hstack([pts, np.ones((len(pts), 1), dtype=np.float32)])
        rotated_pts = (rot_m @ pts_h.T).T
    else:
        rotated = image
        rotated_pts = pts

    xs, ys = rotated_pts[:, 0], rotated_pts[:, 1]
    x1 = int(max(0, xs.min() - padding))
    y1 = int(max(0, ys.min() - padding))
    x2 = int(min(rotated.shape[1], xs.max() + padding))
    y2 = int(min(rotated.shape[0], ys.max() + padding))
    return rotated[y1:y2, x1:x2], rotated_pts


# ── SAM mask selection ──────────────────────────────────────────────────────


def _pick_card_mask(
    mask_candidates: list[tuple[np.ndarray, float]],
    pil_size: tuple[int, int],
) -> tuple[np.ndarray | None, float | None]:
    """Select the mask most likely to be the trading card.

    Filters by IOU score, area fraction, solidity, and aspect ratio match.
    Of the survivors, picks the one with the closest aspect ratio to card
    standard; ties broken by higher IOU score.
    """
    import cv2

    img_w, img_h = pil_size
    img_area = img_w * img_h

    candidates = []
    for mask_np, score in mask_candidates:
        if score < MIN_IOU_SCORE:
            continue

        mask_u8 = mask_np.astype(np.uint8) * 255
        mask_area = int(mask_np.sum())
        area_frac = mask_area / img_area
        if not (MIN_AREA_FRACTION < area_frac < MAX_AREA_FRACTION):
            continue

        contours, _ = cv2.findContours(mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        c = max(contours, key=cv2.contourArea)
        contour_area = cv2.contourArea(c)
        if contour_area < 1:
            continue

        hull = cv2.convexHull(c)
        hull_area = cv2.contourArea(hull)
        solidity = contour_area / hull_area if hull_area > 0 else 0
        if solidity < MIN_SOLIDITY:
            continue

        rect = cv2.minAreaRect(c)
        rw, rh = rect[1]
        if rh == 0 or rw == 0:
            continue
        portrait_aspect = min(rw, rh) / max(rw, rh)
        aspect_err = min(
            abs(portrait_aspect - CARD_ASPECT_PORTRAIT),
            abs(portrait_aspect - CARD_ASPECT_LANDSCAPE),
        )
        if aspect_err > ASPECT_TOLERANCE:
            continue

        candidates.append({"contour": c, "rect": rect, "score": score, "aspect_err": aspect_err})

    if not candidates:
        return None, None

    candidates.sort(key=lambda x: (x["aspect_err"], -x["score"]))
    best = candidates[0]
    box = cv2.boxPoints(best["rect"]).astype(np.float32)
    return box, best["score"]


def _generate_masks(pil_image: Image.Image, model: Any, processor: Any) -> list:
    """Run SAM probe-points and return (mask, score) candidates.

    Computes the image embedding once (expensive) and reuses it across
    all 13 probe points (cheap). Total ~2-3s on CPU per image.
    """
    import torch

    img_w, img_h = pil_image.size
    base_inputs = processor(images=pil_image, return_tensors="pt")
    original_sizes = base_inputs["original_sizes"]
    reshaped_sizes = base_inputs["reshaped_input_sizes"]

    with torch.no_grad():
        image_embeddings = model.get_image_embeddings(base_inputs["pixel_values"])

    results = []
    for fx, fy in PROBE_POINTS_FRACTIONS:
        pt = [fx * img_w, fy * img_h]
        prompt_inputs = processor(
            images=pil_image,
            input_points=[[[pt]]],
            input_labels=[[[1]]],
            return_tensors="pt",
        )
        with torch.no_grad():
            outputs = model(
                image_embeddings=image_embeddings,
                input_points=prompt_inputs.get("input_points"),
                input_labels=prompt_inputs.get("input_labels"),
            )
        masks_tensors = processor.post_process_masks(
            outputs.pred_masks.cpu(),
            original_sizes.cpu(),
            reshaped_sizes.cpu(),
        )
        iou_scores = outputs.iou_scores.cpu()
        for k in range(3):
            mask_np = masks_tensors[0][0, k].numpy().astype(bool)
            score = float(iou_scores[0, 0, k].item())
            results.append((mask_np, score))
    return results


# ── Public API ──────────────────────────────────────────────────────────────


def _open_and_resize(image_bytes: bytes) -> tuple[Image.Image, float]:
    """Open as PIL, resize to ≤ MAX_SAM_SIDE longest edge; return (image, scale)."""
    from io import BytesIO

    img = Image.open(BytesIO(image_bytes)).convert("RGB")
    orig_w, orig_h = img.size
    ratio = min(MAX_SAM_SIDE / orig_w, MAX_SAM_SIDE / orig_h, 1.0)
    if ratio < 1.0:
        new_w, new_h = int(orig_w * ratio), int(orig_h * ratio)
        img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    return img, ratio


def _pil_to_bgr(img: Image.Image) -> np.ndarray:
    arr = np.array(img)  # RGB
    return arr[:, :, ::-1].copy()  # BGR for cv2


def _bgr_to_jpeg_bytes(bgr: np.ndarray) -> bytes:
    import cv2

    ok, buf = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), OUTPUT_JPEG_QUALITY])
    if not ok:
        raise RuntimeError("cv2.imencode failed")
    return bytes(buf)


def sam_crop(image_bytes: bytes) -> bytes | None:
    """SAM-crop an image.

    Returns JPEG bytes of the card, rotated axis-aligned, or None if no
    card mask met all filter thresholds. Callers are expected to pass the
    returned bytes through the cascade validator before using them (the
    cascade does this automatically).

    Note: runs the SAM vision encoder + decoder on CPU. First call incurs
    the ~5-15s model-load cost; subsequent calls are ~2-3s inference.
    """
    try:
        pil_img, scale_ratio = _open_and_resize(image_bytes)
    except Exception as exc:  # noqa: BLE001
        logger.warning("sam_crop: cannot open image: %s", exc)
        return None

    try:
        model, processor = _load_model()
    except Exception:
        logger.exception("sam_crop: model load failed")
        return None

    try:
        mask_candidates = _generate_masks(pil_img, model, processor)
    except Exception:
        logger.exception("sam_crop: mask generation failed")
        return None

    card_pts_sam, _score = _pick_card_mask(mask_candidates, pil_img.size)
    if card_pts_sam is None:
        logger.info("sam_crop: no mask passed filters")
        return None

    # Scale from SAM's resized coords back to the original full-resolution image.
    try:
        bgr = _pil_to_bgr(Image.open(__import__("io").BytesIO(image_bytes)).convert("RGB"))
        orig_pts = card_pts_sam / scale_ratio
        cropped_bgr, _final_pts = _rotate_and_crop(bgr, orig_pts, padding=CROP_PADDING_PX)
        if cropped_bgr.size == 0:
            return None
        return _bgr_to_jpeg_bytes(cropped_bgr)
    except Exception:
        logger.exception("sam_crop: rotate+crop failed")
        return None
