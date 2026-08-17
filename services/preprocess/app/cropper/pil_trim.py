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

**Coordinate spaces.** Detection runs on a downscaled copy (speed), but the
crop is applied to the full-resolution original — the same detect-small /
map-back pattern `sam._open_and_resize` uses. Returning the crop in
downscaled coordinates was a real bug: `validator.is_plausible_crop`
compares the candidate's area against the *original* upload's area, so a
crop measured in downscaled pixels reads ~1/scale² too small. On a
6144x8160 phone photo (scale 0.368) a crop genuinely covering 63.6% of the
frame measured as 8.6% and was rejected by `MIN_AREA_FRACTION`. Keeping
both spaces identical is what makes that comparison meaningful — and it
also removes the 3000px cap on output resolution, which matters because
these crops get printed.

**A threshold cannot tell a printed border from background.** It only
knows "darker than DARK_THRESHOLD", so a card with a saturated border —
2001 Topps teal, an orange card back, a green foil edge — has that border
classified as scanner bed and cropped off. Measured over the corpus, 58
sources lost area this way and 32 lost more than 15%: whole borders,
corner marks and edge copyright text.

The fix does not try to infer how the picture was framed. Framing varies
per user and per shot, and any rule resting on it (that a phone leaves a
margin, that a scan arrives pre-cropped) breaks as soon as someone crops
before uploading. Instead each trim checks its own premise: it assumed the
background sat at one brightness extreme, so the strip it is about to
discard has to actually be that. When it isn't, the frame is kept whole
rather than shaved — see `MAX_BACKGROUND_STRIP_MEAN`.
"""

from __future__ import annotations

import math
from io import BytesIO
from typing import Literal

from PIL import Image, ImageFilter, ImageStat

# Detect on a copy no larger than this on the longest edge — PIL's blur +
# threshold + getbbox pass is slow on 50MP+ inputs and 3000px is more than
# enough to find card edges reliably. This bounds DETECTION only; the crop
# is applied to the full-resolution original.
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

# Brightness the DISCARDED strip must stay under for `trim_dark`'s crop to
# be believed — the check that stops a card's printed border being eaten.
#
# The threshold pipeline cannot tell a border from background; it only
# knows "darker than DARK_THRESHOLD". A card with a saturated border (2001
# Topps teal, an orange card back, a green foil edge) has that border
# classified as scanner bed and cropped away. Measured on the corpus this
# is not an edge case: 58 sources lose area to it and 32 lose more than
# 15% — whole borders, corner marks and edge copyright text. It is
# pre-existing on main, independent of the deskew work, and unrecoverable
# downstream because these print full bleed to the cut line (NEO-152).
#
# The check does NOT reason about how the photo was framed. Framing varies
# per user and per shot, and assuming anything about it (that a phone
# leaves a margin, that a scan is pre-cropped) breaks the moment someone
# crops before uploading. It asks one local question instead: `trim_dark`
# assumed the background was DARK, so is the material it threw away
# actually dark?
#
# Measured mean grey of the discarded strip:
#   real background (dark desk, black scanner bed)  21.1 - 63.5
#   confirmed border shaving                        72.7 - 143.7
# and the unlabelled remainder splits the same way — 56-63 for phone
# photos removing genuine background, then a tight 69-85 cluster of scans
# all removing ~16%, which is the shaving population. 66 sits between.
#
# When it fires the trim keeps the whole frame, which is the recoverable
# direction: a card photographed on a mid-grey desk ships with too much
# background and a knife fixes it, whereas a shaved border is gone for
# good. The genuinely undecidable case — a black-bordered card on a black
# bed — stays undecidable, and is left to the cascade's other stages.
MAX_BACKGROUND_STRIP_MEAN = 66.0

# The same check for `trim_light`, which assumed the background was BRIGHT:
# the discarded strip must be brighter than this. Set by symmetry with
# MAX_BACKGROUND_STRIP_MEAN (255 - 66) rather than measured — only 3
# corpus images are won by trim_light, too few to fit a threshold to.
MIN_BACKGROUND_STRIP_MEAN = 255.0 - MAX_BACKGROUND_STRIP_MEAN

Direction = Literal["above", "below"]


def _open_and_resize(img: Image.Image) -> tuple[Image.Image, float]:
    """Return `(detection_image, scale)` for the detection pass.

    `scale` is the factor the original was multiplied by, so dividing a
    detection-space coordinate by it maps back to the original. 1.0 when
    the image was already small enough and no resize happened.

    Named to match `sam._open_and_resize`, which does the same thing for
    the SAM stage.
    """
    longest = max(img.size)
    if longest <= MAX_LONGEST_EDGE_PX:
        return img, 1.0
    scale = MAX_LONGEST_EDGE_PX / longest
    new_size = (max(1, int(img.width * scale)), max(1, int(img.height * scale)))
    return img.resize(new_size, Image.Resampling.LANCZOS), scale


def _map_box_to_original(
    bbox: tuple[int, int, int, int],
    *,
    scale: float,
    original_size: tuple[int, int],
) -> tuple[int, int, int, int] | None:
    """Map a detection-space bounding box back onto the full-resolution original.

    Expands outward (floor the near edges, ceil the far ones) so the
    1/scale-pixel quantization error introduced by detecting on a
    downscaled copy can only ever *include* a sliver of background, never
    shave a sliver off the card. Result is clamped to the original's
    bounds. Returns None if the mapped box is degenerate.
    """
    left, top, right, bottom = bbox
    orig_w, orig_h = original_size

    if scale < 1.0:
        left = math.floor(left / scale)
        top = math.floor(top / scale)
        right = math.ceil(right / scale)
        bottom = math.ceil(bottom / scale)

    left = max(0, min(left, orig_w))
    top = max(0, min(top, orig_h))
    right = max(0, min(right, orig_w))
    bottom = max(0, min(bottom, orig_h))

    if right - left < 1 or bottom - top < 1:
        return None
    return left, top, right, bottom


def _add_border(cropped: Image.Image) -> bytes:
    """Pad with a black border and encode as JPEG.

    The border stops downstream cropping shaving a pixel-thin slice off
    the card edge. Its colour is cosmetic — it is padding around the card,
    not an attempt to match the background.
    """
    width, height = cropped.size
    bordered = Image.new("RGB", (width + 2 * BORDER_PX, height + 2 * BORDER_PX), color="black")
    bordered.paste(cropped, (BORDER_PX, BORDER_PX))
    out = BytesIO()
    bordered.save(out, format="JPEG", quality=90)
    return out.getvalue()


def _discarded_strip_mean(gray: Image.Image, bbox: tuple[int, int, int, int]) -> float | None:
    """Mean grey of everything outside `bbox` — what the trim would throw away.

    Returns None when the bbox covers the whole image (nothing discarded,
    so there is nothing to check).

    Derived from the two region means rather than by walking pixels, which
    would be millions of Python-level iterations on a 50MP source.
    """
    width, height = gray.size
    left, top, right, bottom = bbox

    outer_count = width * height
    inner_count = max(0, right - left) * max(0, bottom - top)
    discarded_count = outer_count - inner_count
    if discarded_count <= 0:
        return None

    outer_sum = ImageStat.Stat(gray).mean[0] * outer_count
    inner_sum = ImageStat.Stat(gray.crop(bbox)).mean[0] * inner_count
    return (outer_sum - inner_sum) / discarded_count


def _discarded_strip_is_background(
    gray: Image.Image,
    bbox: tuple[int, int, int, int],
    *,
    direction: Direction,
) -> bool:
    """Did the trim throw away background, or the card's own border?

    See `MAX_BACKGROUND_STRIP_MEAN`. `direction` mirrors the threshold
    polarity: "above" assumed a dark background, so the discarded strip
    must be dark; "below" assumed a bright one.
    """
    mean = _discarded_strip_mean(gray, bbox)
    if mean is None:
        return True
    if direction == "above":
        return mean <= MAX_BACKGROUND_STRIP_MEAN
    return mean >= MIN_BACKGROUND_STRIP_MEAN


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
    detect_img, scale = _open_and_resize(img)

    blurred = detect_img.filter(ImageFilter.GaussianBlur(radius=BLUR_RADIUS))
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

    # The threshold cannot tell the card's printed border from background.
    # If what it wants to discard is not background-coloured, it is card —
    # keep the whole frame rather than shaving the border off.
    if not _discarded_strip_is_background(gray, bbox, direction=direction):
        return _add_border(img)

    # Detection happened on the downscaled copy; the crop happens on the
    # original. Without this map-back the output — and every area fraction
    # the validator computes from it — would be in the wrong space.
    mapped = _map_box_to_original(bbox, scale=scale, original_size=img.size)
    if mapped is None:
        return None

    return _add_border(img.crop(mapped))


def trim_dark(image_bytes: bytes) -> bytes | None:
    """Trim for a light card on a dark background (black scanner bed, dark desk)."""
    return _trim_with_threshold(image_bytes, threshold=DARK_THRESHOLD, direction="above")


def trim_light(image_bytes: bytes) -> bytes | None:
    """Trim for a dark card on a light background (white paper, light desk)."""
    return _trim_with_threshold(image_bytes, threshold=LIGHT_THRESHOLD, direction="below")
