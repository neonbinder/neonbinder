"""Scanner-metadata pre-check: is the frame itself already the card? (NEO-191)

Every pixel-based crop strategy in this package answers "where is the card in
this image?" by finding a boundary between card and background. That question
has no answer when the scanner already cropped the background away — and worse,
it has a *confident wrong* answer.

`tiered.border_bg_lab` samples the outer ring of the frame and declares it the
background. On a tightly auto-cropped scan the ring IS the card's own printed
border, so "background" gets defined as part of the card and everything
downstream agrees with itself: the strongest classical rectangle lands on the
inner artwork panel, `margin_is_background` confirms the printed border "is
background", `should_identity` returns False, and the cascade shaves the border
off at a perfect 2.5:3.5 aspect that no later gate can catch. Measured on the
2026-08-27 intake: ~22% of scans shaved, 69% escalated to a ~40s BiRefNet pass
that could not have helped (see NEO-192 — the verify branch meant to catch this
cannot fire on a frame-filling card).

Colour and geometry cannot separate "white printed border" from "white
background": they are the same picture. The information is not in the pixels.

It is in the metadata. A scanner records its resolution, and resolution plus
pixel dimensions is a *physical size*:

    992 x 1384 px at 400 dpi  ->  2.48in x 3.46in

A trading card is 2.5in x 3.5in. A frame that measures one card cannot also
contain a card *plus* background — the card is already that size — so the frame
is the card and there is nothing to crop. Across the 574-image intake batch this
separated cleanly: 547 scans at 2.450-2.500 x 3.450-3.495in (max 2.0% off
nominal) against 27 multi-card bed scans at 8.85 x 4.80in (153% off). Nothing
landed in between.

This is the missing half of a test the cascade already applies.
`tiered.FRAME_CARD_WINDOW` asks whether the frame has card *aspect*; aspect
alone cannot tell a card from a billboard. Resolution supplies the scale.

## Why this cannot over-detect an image that genuinely needs cropping

  - A standard card plus any real margin measures larger than 2.5 x 3.5in and
    falls outside the window.
  - A rotated card's bounding box is strictly larger than the card, so a skewed
    scan fails the size test and still reaches the deskew path.
  - Slabs (~3.25 x 5.25in), toploaders (~3 x 4in) and tallboys (2.5 x 4.75in)
    all measure wrong and fall through to the cascade.
  - Phone photos carry no scanner resolution: all 338 in `main/samples/` report
    72 dpi and are rejected by MIN_SCANNER_DPI alone.

The known hole is a mini / tobacco-size card (1.5 x 2.625in) sitting inside a
card-sized frame, which would falsely read as pre-cropped. We do not scan those.

## Fail-safe direction

Every rejection path returns None, which means "I know nothing — let the pixel
cascade decide", i.e. exactly today's behaviour. This module can only ever
*prevent* a crop, never cause one, so a false negative costs latency and a false
positive is bounded by the size window above.

## Read the ORIGINAL bytes

Resolution does not survive a re-encode. Both `exif.py`'s transpose branch and
any `cv2.imencode` round-trip drop the JFIF density silently. Call this on the
bytes as they arrived, before anything rewrites them.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from io import BytesIO

from PIL import Image

logger = logging.getLogger(__name__)

# Physical dimensions of a standard trading card, in inches.
CARD_WIDTH_IN = 2.5
CARD_HEIGHT_IN = 3.5

# How far each measured side may sit from its nominal card dimension before the
# frame stops counting as "one card". The intake batch's worst true positive is
# 2.0% (cards are cut slightly under-size and scanners round their crop), and
# the nearest true negative is 153% away, so anything in 0.03-0.10 picks the
# same set. 0.03 is the tight end of that plateau: it stays clear of the noise
# without reaching toward the next real card format (a 2.5 x 4.75in tallboy is
# 36% off on the long side).
SIZE_TOLERANCE = 0.03

# Resolution floor for trusting the metadata at all. This is a *provenance*
# check, not a quality one: flatbed and sheet-fed scanners record 200-1200 dpi,
# while cameras and editors stamp a meaningless 72 dpi that says nothing about
# physical size. Every one of the 338 phone photos in `main/samples/` is
# rejected here, before the size window is even considered.
MIN_SCANNER_DPI = 200.0

# Largest relative gap tolerated between horizontal and vertical resolution.
# Real scanners are square or near-square; a wide mismatch means the density
# fields are carrying something other than a physical resolution.
MAX_DPI_ANISOTROPY = 0.01

# JFIF density unit 0 means the density pair is a pixel ASPECT RATIO with no
# physical unit attached — a 1:1 flag would read as "1 dpi" if taken literally.
# Pillow 12 already withholds `info["dpi"]` in that case, so this guard is
# belt-and-braces against a Pillow that forwards the pair anyway; it is checked
# first so the intent survives a dependency bump either way.
JFIF_UNIT_NO_ABSOLUTE_SIZE = 0


@dataclass(frozen=True)
class ScanSize:
    """A frame's physical size, as recorded by the device that produced it."""

    width_in: float
    height_in: float
    dpi: float

    def __str__(self) -> str:
        return f"{self.width_in:.2f}x{self.height_in:.2f}in @{self.dpi:.0f}dpi"


def _trustworthy_dpi(img: Image.Image) -> float | None:
    """The image's resolution in dots-per-inch, or None if it can't be trusted.

    Returns None rather than a best guess for every ambiguous case: absent
    density, an aspect-ratio-only JFIF unit, a non-square resolution, or a value
    below the scanner floor. The caller treats None as "no information".
    """
    if img.info.get("jfif_unit") == JFIF_UNIT_NO_ABSOLUTE_SIZE:
        return None

    density = img.info.get("dpi")
    if not density or len(density) != 2:
        return None

    try:
        # Pillow hands back IFDRational for EXIF-sourced resolution, which does
        # not support arithmetic against floats in every version.
        x_dpi, y_dpi = float(density[0]), float(density[1])
    except (TypeError, ValueError):
        return None

    if x_dpi <= 0 or y_dpi <= 0:
        return None
    if abs(x_dpi - y_dpi) / max(x_dpi, y_dpi) > MAX_DPI_ANISOTROPY:
        return None
    if min(x_dpi, y_dpi) < MIN_SCANNER_DPI:
        return None

    return (x_dpi + y_dpi) / 2


def measure(image_bytes: bytes) -> ScanSize | None:
    """Physical size of the frame, or None when the metadata isn't trustworthy."""
    try:
        with Image.open(BytesIO(image_bytes)) as img:
            width, height = img.size
            dpi = _trustworthy_dpi(img)
    except Exception:  # noqa: BLE001 - unreadable metadata must never fail a crop
        logger.debug("scan_meta: could not read image metadata", exc_info=True)
        return None

    if dpi is None or not width or not height:
        return None
    return ScanSize(width_in=width / dpi, height_in=height / dpi, dpi=dpi)


def is_card_sized_scan(image_bytes: bytes) -> ScanSize | None:
    """Return the measurement when the frame IS one card, else None.

    A non-None result is a positive assertion that there is no background in
    this frame to crop away. None means "no opinion" — the pixel cascade runs
    exactly as it does today.
    """
    size = measure(image_bytes)
    if size is None:
        logger.info("scan_meta: no trustworthy resolution, deferring to the pixel cascade")
        return None

    short_in, long_in = sorted((size.width_in, size.height_in))
    error = max(
        abs(short_in - CARD_WIDTH_IN) / CARD_WIDTH_IN,
        abs(long_in - CARD_HEIGHT_IN) / CARD_HEIGHT_IN,
    )
    if error > SIZE_TOLERANCE:
        logger.info("scan_meta: %s is %.0f%% off card size, cascade owns it", size, error * 100)
        return None

    logger.info("scan_meta: %s is one card, identity without a pixel pass", size)
    return size
