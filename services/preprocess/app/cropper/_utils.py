"""Internal utilities shared by the crop cascade."""

from __future__ import annotations

from io import BytesIO

from PIL import Image


def rotate_image_bytes(image_bytes: bytes, degrees_ccw: int) -> bytes:
    """Rotate image bytes by the given CCW degrees, preserving format.

    Zero-rotation short-circuits to avoid a pointless re-encode.
    """
    if degrees_ccw % 360 == 0:
        return image_bytes
    with Image.open(BytesIO(image_bytes)) as img:
        fmt = img.format or "JPEG"
        rotated = img.rotate(degrees_ccw, expand=True)
        out = BytesIO()
        rotated.save(out, format=fmt)
        return out.getvalue()
