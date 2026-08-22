"""EXIF orientation normalisation.

Phone cameras almost never rotate pixels. They store the sensor readout as-is
and record how the phone was held in EXIF tag 0x0112, leaving the viewer to
rotate at display time. A zip of phone photos is therefore full of JPEGs whose
*pixel* orientation is sideways even though every image viewer shows them
upright.

Nothing else in this service looks at EXIF. `/process` gets away with it
because its callers are already handing over a crop or a photo they picked out
of a picker, and `app.orient` derives rotation from the text itself, so a
sideways card still ends up classified correctly — just with a rotation report
that describes the stored pixels rather than what the photographer saw.

That stops being good enough for the NEO-149 zip job, which writes derived
image objects clients render directly. So the job normalises on extract,
before the cascade, and everything downstream — crop geometry, the Vision
orient, `rotation_degrees` in the manifest — is expressed against the
normalised pixels.

## Rotation sign convention (this crosses a service boundary — read it)

This service reports rotation **counter-clockwise**: `rotation_degrees` is the
CCW rotation to apply to make the text upright, matching
`PIL.Image.rotate(degrees)`, which is also CCW.

`sharp.rotate(deg)` in Node — what the web client uses — is **clockwise**. A
client applying a service-reported rotation must negate it:

    sharp(buf).rotate(-rotation_degrees)

The zip job side-steps the whole question for its own output by writing
already-rotated bytes and flagging them (`rotation_applied: true` in the
manifest), but the convention still governs anyone reading `rotation_degrees`
off `/process`.
"""

from __future__ import annotations

import logging
from io import BytesIO

from PIL import Image, ImageOps

logger = logging.getLogger(__name__)

# EXIF tag 0x0112 is Orientation. Value 1 (and an absent tag) means "the
# pixels are already the right way up"; 2..8 are the seven flip/rotate
# combinations a viewer is expected to apply. Anything outside 1..8 is a
# malformed tag and is treated as 1.
EXIF_ORIENTATION_TAG = 0x0112
EXIF_ORIENTATION_AS_STORED = 1
EXIF_ORIENTATION_VALUES = frozenset(range(1, 9))

# Quality used when an image's pixels had to be rewritten. A transpose forces
# a re-encode, and that generation of loss is unavoidable; 95 keeps it
# invisible at the scale the downstream Vision OCR and SAM care about, at
# roughly 1.5x the file size of the 85 used elsewhere in this service for
# images that are only ever *shown* to a model.
EXIF_REENCODE_JPEG_QUALITY = 95

# Formats we re-encode a transposed image back into. Anything else (a mode or
# format PIL can read but not round-trip cleanly) is written as JPEG, which
# every consumer of this service already handles.
_ROUND_TRIP_FORMATS = frozenset({"JPEG", "PNG", "WEBP"})


def read_exif_orientation(image_bytes: bytes) -> int:
    """Return the image's EXIF orientation tag, or 1 when there isn't a usable one.

    Total function: an unreadable image, a missing EXIF block and an
    out-of-range tag value all collapse to `EXIF_ORIENTATION_AS_STORED`, since
    all three mean the same thing operationally — do not transpose.
    """
    try:
        with Image.open(BytesIO(image_bytes)) as img:
            exif = img.getexif()
            value = exif.get(EXIF_ORIENTATION_TAG)
    except Exception:  # noqa: BLE001 - a broken EXIF block must not fail an image
        logger.debug("exif: orientation unreadable, assuming as-stored", exc_info=True)
        return EXIF_ORIENTATION_AS_STORED

    if not isinstance(value, int) or value not in EXIF_ORIENTATION_VALUES:
        return EXIF_ORIENTATION_AS_STORED
    return value


def apply_exif_orientation(image_bytes: bytes) -> tuple[bytes, int]:
    """Bake an image's EXIF orientation into its pixels.

    Returns `(bytes, orientation)` where `orientation` is the tag that was
    found. When it is `EXIF_ORIENTATION_AS_STORED` the **original bytes object
    is returned unchanged** — no decode/re-encode, so the overwhelmingly common
    case (a screenshot, a scanner output, an already-normalised photo) costs
    nothing and loses no quality.

    Otherwise the pixels are transposed, the now-misleading orientation tag is
    dropped by `ImageOps.exif_transpose`, and the result is re-encoded in the
    source format.
    """
    orientation = read_exif_orientation(image_bytes)
    if orientation == EXIF_ORIENTATION_AS_STORED:
        return image_bytes, orientation

    with Image.open(BytesIO(image_bytes)) as img:
        source_format = (img.format or "JPEG").upper()
        transposed = ImageOps.exif_transpose(img)

    out = BytesIO()
    if source_format in _ROUND_TRIP_FORMATS:
        target_format = source_format
    else:
        target_format = "JPEG"

    if target_format == "JPEG":
        # JPEG cannot hold an alpha channel or a palette; a transposed PNG-ish
        # image falling back to JPEG has to be flattened first.
        transposed = transposed.convert("RGB")
        transposed.save(out, format="JPEG", quality=EXIF_REENCODE_JPEG_QUALITY)
    else:
        transposed.save(out, format=target_format)

    logger.info("exif: normalised orientation=%d format=%s", orientation, target_format)
    return out.getvalue(), orientation
