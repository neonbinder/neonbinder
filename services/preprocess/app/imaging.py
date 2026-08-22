"""Decoded-raster limits — the ceiling that is measured in pixels, not bytes.

Every other size limit in this service bounds a *file*: `MAX_IMAGE_BYTES` on
the multipart routes, `MAX_ENTRY_UNCOMPRESSED_BYTES` and
`MAX_TOTAL_UNCOMPRESSED_BYTES` in `app.jobs.zipsafe`. None of them bounds what
an image costs once it is decoded, and for image formats those two numbers are
only loosely related.

A flat 13000x13000 RGB PNG is **506 KB on disk and 484 MB decoded**. It clears
every byte ceiling with room to spare — 1/65th of the per-entry cap, and small
enough that `app.jobs.zipsafe._check_ratio` skips it entirely for being under
`RATIO_CHECK_MIN_BYTES`. Nine hundred of them fit inside both the 500 MB upload
policy and the 1000-entry cap. The decode is then repeated several times per
image with copies live simultaneously: the EXIF transpose and re-encode in
`app.exif`, `app.cropper._utils.rotate_image_bytes`, `pil_trim`'s
convert/blur/convert, and `sam.py`'s `np.array(img)` making a second full-size
buffer. Bytes are simply the wrong unit for any of that.

Pillow ships a decompression-bomb check, but its default only *warns* below
178,956,970 px, so 169 MP sits deliberately underneath it. Two things happen
here instead:

1. `Image.MAX_IMAGE_PIXELS` is lowered process-wide on import, which puts a
   floor under every decode anywhere in the service — including the ones inside
   crop strategies that never see this module.
2. `read_raster_size` reads dimensions from the **lazy** `Image.open` header,
   so a caller can reject an image before a single row of pixels is decoded.
   That is what the zip job does, which turns a bomb into one recorded
   per-image failure rather than an instance-wide OOM.
"""

from __future__ import annotations

import logging
import warnings
from io import BytesIO

from PIL import Image

logger = logging.getLogger(__name__)

# Most pixels we will decode in one image.
#
# The number is set by the largest thing a real camera produces, not by card
# geometry: an iPhone in 48 MP mode emits 8064x6048 = 48,771,072 px, and
# full-frame bodies reach 61 MP. Rejecting those would be a product bug, since
# a zip of phone photos is exactly the input this feature exists for. 50 MP
# clears the iPhone case with a little room and still bounds one decoded RGB
# raster at ~150 MB, against a 4 GiB instance that is also holding SAM.
#
# For scale, the bomb this defends against is 169 MP / 484 MB, and Pillow's own
# default does not raise until 178,956,970 px.
MAX_IMAGE_PIXELS = 50_000_000

# Lower Pillow's process-wide bomb ceiling to match. This is a module-level
# side effect on purpose: it is the only way to protect decode paths that do
# not call anything in this module — `pil_trim`, `sam`, `validator`, `classify`
# all open images themselves. Pillow raises `DecompressionBombError` above
# twice this value and warns above it; `read_raster_size` below is what makes
# the ceiling exact rather than a factor of two loose.
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS


class RasterTooLargeError(ValueError):
    """The image decodes to more pixels than `MAX_IMAGE_PIXELS` allows."""


def read_raster_size(image_bytes: bytes) -> tuple[int, int] | None:
    """Dimensions from the image header, without decoding any pixels.

    `Image.open` is lazy — it parses the header and stops — so this costs
    almost nothing and, crucially, happens before any allocation proportional
    to the raster.

    Returns None when the header cannot be read at all. That is deliberately
    *not* an error here: callers already have their own handling for
    undecodable bytes (the cascade's per-strategy failure path, the job's
    per-image failure record), and turning "this is not an image" into "this is
    too big" would be a worse diagnosis than the one they already produce.
    """
    try:
        with warnings.catch_warnings():
            # We are about to check the size ourselves and report it precisely;
            # Pillow's warning on the way past is noise.
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            with Image.open(BytesIO(image_bytes)) as img:
                return img.size
    except Image.DecompressionBombError:
        # Above 2x the ceiling Pillow refuses to even report a size. That is
        # unambiguously over the limit, so answer for it rather than reporting
        # "unreadable" and letting the caller treat a bomb as a corrupt file.
        raise RasterTooLargeError(f"image exceeds {MAX_IMAGE_PIXELS} pixel limit") from None
    except Exception:  # noqa: BLE001 - an unreadable header is the caller's problem
        logger.debug("imaging: could not read raster dimensions", exc_info=True)
        return None


def check_raster_size(image_bytes: bytes) -> tuple[int, int] | None:
    """Raise `RasterTooLargeError` if this image would decode past the ceiling.

    Returns the dimensions when they are known and acceptable, or None when the
    header was unreadable — see `read_raster_size` for why that is not an error.
    """
    size = read_raster_size(image_bytes)
    if size is None:
        return None

    width, height = size
    if width * height > MAX_IMAGE_PIXELS:
        raise RasterTooLargeError(
            f"image is {width}x{height} ({width * height} pixels), "
            f"over the {MAX_IMAGE_PIXELS} pixel limit"
        )
    return size
