"""The two sizes a saved card's photo is kept in (NEO-427).

A card saved from a scanner run takes its photos from that run's cropped
output. The collector's browser never holds those bytes, so this service makes
the sizes Convex stores on the copy (`collectionCopyPhotos`, NEO-377).

The numbers mirror `COPY_PHOTO_LONG_EDGE`, `COPY_PHOTO_THUMB_EDGE`,
`MAX_COPY_PHOTO_BYTES` and `MAX_COPY_THUMB_BYTES` in
`apps/web/convex/copyPhotos.ts`. Convex refuses anything over its own limits,
so a drift here fails the attach rather than storing the wrong thing.

Both files are JPEG with no EXIF, XMP or comment: a photo here ends up on public
share pages and marketplace listings, and only the pixels and a colour profile
of ordinary size belong there.
"""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO

from PIL import Image

COPY_PHOTO_LONG_EDGE = 1600
COPY_PHOTO_THUMB_EDGE = 360
MAX_COPY_PHOTO_BYTES = 3 * 1024 * 1024
MAX_COPY_THUMB_BYTES = 256 * 1024
COPY_PHOTO_CONTENT_TYPE = "image/jpeg"

# A profile bigger than this is dropped. An ordinary sRGB or Display P3 profile
# is a few KB, and the thumbnail's whole limit is 256 KB, so a profile of that
# order would fail the thumbnail every time whatever its pixels were.
MAX_ICC_PROFILE_BYTES = 16 * 1024

# Tried best first until a file fits its limit. A card at 1600px clears the
# limit at the first step; the rest exist for an unusually noisy scan.
_JPEG_QUALITIES = (90, 82, 74, 66, 58, 50)

# Where a transparent pixel lands. A card crop has none in practice, but a PNG
# can carry them and JPEG has no alpha to keep them in.
_FLATTEN_BACKGROUND = (255, 255, 255)


class CopyPhotoTooLargeError(ValueError):
    """Even the lowest quality step does not fit the size limit."""


@dataclass(frozen=True)
class DerivedCopyPhotos:
    image: bytes
    thumb: bytes
    content_type: str = COPY_PHOTO_CONTENT_TYPE


def _to_rgb(img: Image.Image) -> Image.Image:
    """RGB pixels, with any transparency flattened onto the background."""
    if img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info:
        rgba = img.convert("RGBA")
        flat = Image.new("RGB", rgba.size, _FLATTEN_BACKGROUND)
        flat.paste(rgba, mask=rgba.getchannel("A"))
        return flat
    return img.convert("RGB")


def _encode_within(img: Image.Image, max_bytes: int, icc_profile: bytes | None) -> bytes:
    for quality in _JPEG_QUALITIES:
        out = BytesIO()
        img.save(out, format="JPEG", quality=quality, optimize=True, icc_profile=icc_profile)
        if out.tell() <= max_bytes:
            return out.getvalue()
    raise CopyPhotoTooLargeError(f"no JPEG quality fits {max_bytes} bytes")


def derive_copy_photos(image_bytes: bytes) -> DerivedCopyPhotos:
    """Make the listing-sized photo and the thumbnail from one stored image.

    Only ever shrinks: a small scan stays its own size rather than being blown
    up past the detail it has. Raises whatever Pillow raises on undecodable
    bytes, and `CopyPhotoTooLargeError`; the caller checks the raster size first.
    """
    with Image.open(BytesIO(image_bytes)) as source:
        source.load()
        # A profile describes the source's own colour space, so it only still
        # applies when `convert` leaves the pixels in that space.
        icc_profile = source.info.get("icc_profile") if source.mode == "RGB" else None
        image = _to_rgb(source)
    # `convert` carries the source's metadata along and JPEG save writes what it
    # finds here (a comment, XMP), whatever is passed to `save`.
    image.info.clear()
    if icc_profile is not None and len(icc_profile) > MAX_ICC_PROFILE_BYTES:
        icc_profile = None

    image.thumbnail((COPY_PHOTO_LONG_EDGE, COPY_PHOTO_LONG_EDGE), Image.Resampling.LANCZOS)
    encoded_image = _encode_within(image, MAX_COPY_PHOTO_BYTES, icc_profile)

    image.thumbnail((COPY_PHOTO_THUMB_EDGE, COPY_PHOTO_THUMB_EDGE), Image.Resampling.LANCZOS)
    encoded_thumb = _encode_within(image, MAX_COPY_THUMB_BYTES, icc_profile)

    return DerivedCopyPhotos(image=encoded_image, thumb=encoded_thumb)
