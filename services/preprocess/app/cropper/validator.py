"""Crop-candidate validator — port of script-frontend's isPlausibleCardCrop.

Rejects candidates that are too small, too off-ratio, too tiny a fraction of
the source, or too uniform (blank / near-uniform pixels). The cascade uses
this to short-circuit on the client's precropped upload and to gate each
server-side crop attempt's output.

Tuning knobs are module-level constants so they're easy to find and bump.
"""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO

from PIL import Image, ImageStat

# Standard trading-card aspect ratios (2.5" × 3.5").
CARD_ASPECT_PORTRAIT = 2.5 / 3.5  # ≈ 0.7143
CARD_ASPECT_LANDSCAPE = 3.5 / 2.5  # = 1.40
ASPECT_TOLERANCE = 0.15  # ±15% — matches script-frontend's ASPECT_TOLERANCE.

# Reject candidates smaller than this on either side — too small means Vision
# OCR + Haiku classify won't have enough signal regardless of aspect.
MIN_SIDE_PX = 300

# When called with a source image, a good crop should cover a meaningful
# fraction of the source. Rejects crops that zoomed into a tiny slice.
MIN_AREA_FRACTION = 0.10

# Standard deviation on the grayscale channel — below this is basically
# a uniform-color image (blank paper, black backdrop, empty scanner bed).
# Threshold picked empirically: a solid wall-colored backdrop around the
# card body tends to produce stddev in the 20-40 range; an actual blank
# image sits near 0.
MIN_GRAYSCALE_STDDEV = 10.0


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    reason: str | None = None


def is_plausible_crop(
    image_bytes: bytes,
    *,
    source_area_bytes: bytes | None = None,
) -> ValidationResult:
    """Validate that `image_bytes` could plausibly be a trading card.

    Args:
        image_bytes: candidate crop to check.
        source_area_bytes: if provided, an area-fraction check is applied
            (candidate must cover MIN_AREA_FRACTION of the source's area).
            Used when validating cascade outputs against the original upload.
    """
    try:
        img = Image.open(BytesIO(image_bytes))
        img.load()
    except Exception as exc:  # noqa: BLE001
        return ValidationResult(ok=False, reason=f"cannot open image: {exc}")

    w, h = img.size
    if w < MIN_SIDE_PX or h < MIN_SIDE_PX:
        return ValidationResult(ok=False, reason=f"too small {w}x{h}")

    ratio = w / h if h else 0
    portrait_err = abs(ratio - CARD_ASPECT_PORTRAIT) / CARD_ASPECT_PORTRAIT
    landscape_err = abs(ratio - CARD_ASPECT_LANDSCAPE) / CARD_ASPECT_LANDSCAPE
    min_err = min(portrait_err, landscape_err)
    if min_err > ASPECT_TOLERANCE:
        return ValidationResult(
            ok=False,
            reason=f"aspect {ratio:.3f} off by {min_err * 100:.0f}%",
        )

    if source_area_bytes is not None:
        try:
            src = Image.open(BytesIO(source_area_bytes))
            src_area = src.width * src.height
            crop_area = w * h
            if src_area > 0:
                fraction = crop_area / src_area
                if fraction < MIN_AREA_FRACTION:
                    return ValidationResult(
                        ok=False,
                        reason=f"covers only {fraction * 100:.1f}% of source",
                    )
        except Exception:  # noqa: BLE001
            pass  # can't open source → skip the area check

    try:
        gray = img.convert("L")
        stddev = ImageStat.Stat(gray).stddev[0]
    except Exception as exc:  # noqa: BLE001
        return ValidationResult(ok=False, reason=f"stddev read failed: {exc}")
    if stddev < MIN_GRAYSCALE_STDDEV:
        return ValidationResult(ok=False, reason=f"near-uniform (stddev {stddev:.1f})")

    return ValidationResult(ok=True)
