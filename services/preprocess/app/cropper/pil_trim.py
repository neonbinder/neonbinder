"""PIL-based trim — port of script-frontend's sharp.trim / magick.fuzz.trim.

Works on clean-background photos of a single card: blur to smooth JPEG
artifacts, threshold to separate card from background, take the bounding
box, add a small border so downstream orient/classify don't clip the card
edge.

Two public entrypoints — same pipeline, opposite threshold directions:

    trim_dark  — card is LIGHTER than the background
                 (black scanner bed, dark desk). Foreground = pixels above
                 `DARK_THRESHOLD`.

    trim_light — card is DARKER than the background
                 (white paper, light desk). Foreground = pixels below
                 `LIGHT_THRESHOLD`.

Both are registered as separate strategies in the cascade so each goes
through the validator + text-count gate independently. Most clean-card
photos are one or the other; the cascade just runs whichever wins.
"""

from __future__ import annotations

from io import BytesIO
from typing import Literal

from PIL import Image, ImageFilter

# Downscale very large images before processing — libvips / PIL are slow on
# 50MP+ inputs. 3000px longest edge is enough to find card edges reliably.
MAX_LONGEST_EDGE_PX = 3000

# Gaussian blur radius before thresholding. Smooths JPEG artifacts + film
# grain without dissolving real card edges.
BLUR_RADIUS = 0.8

# Threshold for "is this pixel background?" on the grayscale channel.
# 180 matches script-frontend's sharp.trim (dark backgrounds).
DARK_THRESHOLD = 180
# Chosen empirically: backgrounds brighter than ~240 (paper white) reliably
# sit above this, while card content typically has some sub-75 pixels
# (shadows, dark text, borders). If cards start slipping through on mid-
# tone light backgrounds, bump upward.
LIGHT_THRESHOLD = 75

# Border added back around the bounding box so orient + classify have
# breathing room. In pixels.
BORDER_PX = 10

Direction = Literal["above", "below"]


def _maybe_downscale(img: Image.Image) -> Image.Image:
    longest = max(img.size)
    if longest <= MAX_LONGEST_EDGE_PX:
        return img
    scale = MAX_LONGEST_EDGE_PX / longest
    new_size = (int(img.width * scale), int(img.height * scale))
    return img.resize(new_size, Image.Resampling.LANCZOS)


def _trim_with_threshold(
    image_bytes: bytes,
    *,
    threshold: int,
    direction: Direction,
) -> bytes | None:
    """Shared trim pipeline parameterized by threshold direction.

    direction="above": foreground = pixels brighter than threshold (dark background).
    direction="below": foreground = pixels darker than threshold (light background).

    Returns trimmed JPEG bytes, or None if no meaningful bounding box was
    found (unreadable input, or every pixel is on one side of the threshold).
    """
    try:
        img = Image.open(BytesIO(image_bytes))
        img.load()
    except Exception:  # noqa: BLE001
        return None

    img = img.convert("RGB")
    img = _maybe_downscale(img)

    blurred = img.filter(ImageFilter.GaussianBlur(radius=BLUR_RADIUS))
    gray = blurred.convert("L")

    # Binary mask where foreground pixels are 255 and background is 0;
    # getbbox() then returns the bounding box of foreground.
    if direction == "above":
        mask = gray.point(lambda p: 255 if p > threshold else 0, mode="L")
    else:  # "below"
        mask = gray.point(lambda p: 255 if p < threshold else 0, mode="L")

    bbox = mask.getbbox()
    if bbox is None:
        return None

    left, top, right, bottom = bbox
    if right - left < 1 or bottom - top < 1:
        return None

    cropped = img.crop(bbox)

    # Add a black border so downstream cropping doesn't shave off a pixel-
    # thin slice of the card edge. Border color is cosmetic — it's padding
    # around the card, not a background match.
    w, h = cropped.size
    bordered = Image.new("RGB", (w + 2 * BORDER_PX, h + 2 * BORDER_PX), color="black")
    bordered.paste(cropped, (BORDER_PX, BORDER_PX))

    out = BytesIO()
    bordered.save(out, format="JPEG", quality=90)
    return out.getvalue()


def trim_dark(image_bytes: bytes) -> bytes | None:
    """Trim for a light card on a dark background (black scanner bed, dark desk)."""
    return _trim_with_threshold(image_bytes, threshold=DARK_THRESHOLD, direction="above")


def trim_light(image_bytes: bytes) -> bytes | None:
    """Trim for a dark card on a light background (white paper, light desk)."""
    return _trim_with_threshold(image_bytes, threshold=LIGHT_THRESHOLD, direction="below")
