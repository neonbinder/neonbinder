"""Haiku-based bounding-box crop.

When SAM fails to find a plausible card mask — usually unusual card shapes,
heavy occlusion, or backgrounds where SAM's center-biased probes miss the
card — this stage asks Claude Haiku to locate the card and crops via PIL.
Cheap (~$0.0005 per call), no additional runtime deps (anthropic SDK is
already loaded for classify).

Public API: `haiku_bbox_crop(image_bytes) -> bytes | None`. Returns JPEG
bytes of the cropped region, or None if Haiku couldn't identify a card.

Implementation note: the image we feed Haiku goes through the same
downscale step as the classify call (`_prepare_for_anthropic` — ≤3.5 MB
raw to stay under Anthropic's 5 MB base64 cap). Haiku's bounding box
therefore lives in the downscaled coordinate system; we rescale back to
the original dimensions before cropping so the output preserves full
resolution for downstream orient + classify.
"""

from __future__ import annotations

import base64
import json
import logging
from io import BytesIO

import anthropic
from PIL import Image

from app.classify import _prepare_for_anthropic

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "claude-haiku-4-5-20251001"
MAX_TOKENS = 200
TEMPERATURE = 0.0

PROMPT = """You are looking at a photo that contains a single trading card.

Return the bounding box of the card as a JSON object with integer pixel
coordinates relative to the input image dimensions:

  {"x": <left>, "y": <top>, "w": <width>, "h": <height>}

The box should tightly enclose the card INCLUDING its border but EXCLUDING
the background / desk / hands / etc.

If no card is clearly visible, or you are uncertain about the bounds,
return {"x": 0, "y": 0, "w": 0, "h": 0}.

Respond with ONLY the JSON object. No preamble, no markdown, no code fences."""


def _strip_code_fences(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[1] if "\n" in stripped else stripped[3:]
        if stripped.rstrip().endswith("```"):
            stripped = stripped.rstrip()[:-3]
    return stripped.strip()


def _parse_bbox(text: str) -> tuple[int, int, int, int] | None:
    """Parse Haiku's JSON response into (x, y, w, h). None on any failure."""
    try:
        data = json.loads(_strip_code_fences(text))
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    try:
        x = int(data["x"])
        y = int(data["y"])
        w = int(data["w"])
        h = int(data["h"])
    except (KeyError, ValueError, TypeError):
        return None
    if w <= 0 or h <= 0:
        return None
    return x, y, w, h


def _call_haiku(
    client: anthropic.Anthropic,
    *,
    payload: bytes,
    media_type: str,
    model: str,
) -> str:
    b64 = base64.b64encode(payload).decode("ascii")
    response = client.messages.create(
        model=model,
        max_tokens=MAX_TOKENS,
        temperature=TEMPERATURE,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": b64,
                        },
                    },
                    {"type": "text", "text": PROMPT},
                ],
            }
        ],
    )
    if not response.content:
        return ""
    block = response.content[0]
    return getattr(block, "text", "") or ""


def _rescale_bbox(
    bbox: tuple[int, int, int, int],
    *,
    downscaled_size: tuple[int, int],
    original_size: tuple[int, int],
) -> tuple[int, int, int, int] | None:
    """Rescale bbox from downscaled space to original, clamp to image bounds."""
    dx, dy, dw, dh = bbox
    ddw, ddh = downscaled_size
    ow, oh = original_size
    if ddw <= 0 or ddh <= 0:
        return None

    scale_x = ow / ddw
    scale_y = oh / ddh
    x = max(0, int(dx * scale_x))
    y = max(0, int(dy * scale_y))
    w = max(1, int(dw * scale_x))
    h = max(1, int(dh * scale_y))
    if x + w > ow:
        w = ow - x
    if y + h > oh:
        h = oh - y
    if w <= 0 or h <= 0:
        return None
    return x, y, w, h


def haiku_bbox_crop(
    image_bytes: bytes,
    *,
    client: anthropic.Anthropic | None = None,
    model: str = DEFAULT_MODEL,
) -> bytes | None:
    """Crop the card from `image_bytes` using Haiku's bounding box.

    Returns JPEG bytes of the cropped region, or None if Haiku couldn't
    locate a card or any step failed. The cascade's text-count + validator
    gates still apply downstream.
    """
    if not image_bytes:
        return None

    ai_client = client or anthropic.Anthropic()

    try:
        payload, media_type = _prepare_for_anthropic(image_bytes)
    except Exception:
        logger.exception("haiku_bbox: _prepare_for_anthropic failed")
        return None

    try:
        text = _call_haiku(ai_client, payload=payload, media_type=media_type, model=model)
    except Exception:
        logger.exception("haiku_bbox: Haiku call failed")
        return None

    bbox = _parse_bbox(text)
    if bbox is None:
        logger.info("haiku_bbox: no valid bbox in response %r", text[:200])
        return None

    try:
        with Image.open(BytesIO(payload)) as downscaled:
            downscaled_size = downscaled.size
        with Image.open(BytesIO(image_bytes)) as original:
            original_size = original.size
    except Exception:
        logger.exception("haiku_bbox: failed to read image dimensions")
        return None

    scaled = _rescale_bbox(
        bbox,
        downscaled_size=downscaled_size,
        original_size=original_size,
    )
    if scaled is None:
        logger.info("haiku_bbox: rescale produced empty bbox")
        return None

    x, y, w, h = scaled
    try:
        with Image.open(BytesIO(image_bytes)) as img:
            cropped = img.convert("RGB").crop((x, y, x + w, y + h))
            out = BytesIO()
            cropped.save(out, format="JPEG", quality=90)
            return out.getvalue()
    except Exception:
        logger.exception("haiku_bbox: PIL crop failed")
        return None
