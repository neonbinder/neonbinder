"""Crop cascade orchestration.

Mirrors the cropAttempts waterfall from script-frontend's imageProcessor.js
but restricted to strategies that run server-side (macOS Swift croppers stay
client-side).

Every cropping strategy — including the client-supplied `precropped` —
flows through the SAME two-gate check, so adding a new cropper (MobileSAM,
classical contour, ...) is just a matter of appending to `_STRATEGIES`.
The gates are applied in the wrapper, not in each strategy, so a new
cropper can't accidentally skip fallback logic.

Gates (applied to every strategy uniformly):

1. **Geometric validation** (`validator.is_plausible_crop`) — min size,
   aspect ratio within tolerance, area fraction vs. source, non-blank
   stddev. Rejects technically malformed crops.

2. **Text-count regression guard** — the baseline is orient's text count
   on the raw passthrough. A cropper's output must retain at least
   `MIN_CASCADE_TEXT_RATIO` of that baseline, or the stage is rejected.
   Catches wrong-region crops that *happen* to be card-shaped.

If every strategy fails, the passthrough fallback carries whatever
orient+classify produced on the raw image. The client can surface an
empty-players / null-card_number response as "preprocess couldn't
identify this card" and route to a manual path upstream.

Source labels (order of preference):
    precropped      : client-supplied crop, or the raw upload as fallback
    pil_trim_dark   : PIL blur + threshold + trim (card lighter than bg)
    pil_trim_light  : PIL blur + threshold + trim (card darker than bg)
    sam             : SAM ViT-B semantic segmentation
    haiku_bbox      : Anthropic Haiku bounding-box crop
    passthrough     : raw image forwarded unchanged
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass

from app.classify import ClassifyResult, classify_card
from app.cropper import haiku_bbox, pil_trim, sam
from app.cropper._utils import rotate_image_bytes
from app.cropper.validator import is_plausible_crop
from app.orient import OrientationResult, detect_orientation

logger = logging.getLogger(__name__)

# A cascade stage must retain at least this fraction of the baseline orient
# text count or the stage is rejected. 0.8 tolerates Vision's jitter between
# similar crops without letting a wrong-region crop slip through.
MIN_CASCADE_TEXT_RATIO = 0.8

# In crop-only mode (no original uploaded) there's no baseline to regress
# from, so the text-count gate becomes an absolute floor: Vision must find
# at least this many text tokens on the crop for it to be considered a card.
# 1 is enough to distinguish blank/scenery images from cards while staying
# permissive enough that legitimate low-text crops (e.g. backs of early
# cards) still pass.
MIN_ABSOLUTE_TEXT_COUNT = 1

# Type for a crop strategy: takes raw image bytes, returns cropped bytes or None.
CropStrategy = Callable[[bytes], bytes | None]

# Ordered list of server-side crop strategies. Each one flows through the
# same two-gate wrapper (`_try_stage` below). Stored as (name, module, attr)
# so the callable is looked up fresh at each cascade invocation — tests
# monkey-patch the module attribute and the cascade picks up the patch.
#
# `precropped` is NOT in this list — it's handled as stage 1 inside `crop()`
# because the candidate bytes come from a kwarg, not from applying a
# function to `image_bytes`. Gate application is identical.
_STRATEGIES: list[tuple[str, object, str]] = [
    ("pil_trim_dark", pil_trim, "trim_dark"),
    ("pil_trim_light", pil_trim, "trim_light"),
    ("sam", sam, "sam_crop"),
    ("haiku_bbox", haiku_bbox, "haiku_bbox_crop"),
]

# Public, ordered tuple of strategy names. Both the cascade and the
# /crop endpoint walk this — single source of truth for ordering.
STRATEGY_NAMES: tuple[str, ...] = tuple(name for name, _module, _attr in _STRATEGIES)


class UnknownStrategyError(ValueError):
    """Raised when a strategy identifier (name or index) doesn't resolve."""


def resolve_strategy_identifier(identifier: str | int) -> str:
    """Resolve a strategy name or 0-based index to its canonical name.

    Accepts:
      - a strategy name string (e.g. "sam") — returned as-is if valid
      - an int index into STRATEGY_NAMES (e.g. 2)
      - a numeric string interpreted as an index (e.g. "2")

    Raises UnknownStrategyError on unknown name, out-of-range index,
    negative index, or non-numeric junk.
    """
    if isinstance(identifier, bool):  # bool is an int subclass — exclude it
        raise UnknownStrategyError(
            f"invalid strategy identifier: {identifier!r}; " f"valid names: {list(STRATEGY_NAMES)}"
        )
    if isinstance(identifier, int):
        if 0 <= identifier < len(STRATEGY_NAMES):
            return STRATEGY_NAMES[identifier]
        raise UnknownStrategyError(
            f"strategy index {identifier} out of range; "
            f"valid indices: 0..{len(STRATEGY_NAMES) - 1}"
        )
    if isinstance(identifier, str):
        if identifier in STRATEGY_NAMES:
            return identifier
        # Numeric string → index
        stripped = identifier.strip()
        if stripped.lstrip("-").isdigit():
            try:
                idx = int(stripped)
            except ValueError:
                pass
            else:
                if 0 <= idx < len(STRATEGY_NAMES):
                    return STRATEGY_NAMES[idx]
                raise UnknownStrategyError(
                    f"strategy index {idx} out of range; "
                    f"valid indices: 0..{len(STRATEGY_NAMES) - 1}"
                )
        raise UnknownStrategyError(
            f"unknown strategy {identifier!r}; valid names: {list(STRATEGY_NAMES)}"
        )
    raise UnknownStrategyError(f"invalid strategy identifier type: {type(identifier).__name__}")


def _strategy_callable(name: str) -> CropStrategy:
    """Look up the strategy callable fresh on every call.

    Tests rely on monkey-patching the module attribute (e.g.
    `monkeypatch.setattr(cropper.sam, "sam_crop", ...)`) and expect the
    cascade to pick up the patch, so we resolve via `getattr` here rather
    than capturing the function object at import time.
    """
    for entry_name, module, attr in _STRATEGIES:
        if entry_name == name:
            return getattr(module, attr)  # type: ignore[no-any-return]
    raise UnknownStrategyError(f"unknown strategy {name!r}; valid names: {list(STRATEGY_NAMES)}")


def run_strategy_capturing(name: str, image_bytes: bytes) -> tuple[bytes | None, str | None]:
    """Run a single strategy, capturing exceptions as a class-name string.

    Returns `(produced_bytes, error_class_name)`:
      - success → (bytes, None)
      - strategy returned None → (None, None)
      - strategy raised → (None, "<ExcClass>"); a warning is logged

    Lets `/crop` distinguish "ran cleanly, found nothing" from "crashed".
    """
    fn = _strategy_callable(name)
    try:
        produced = fn(image_bytes)
    except Exception as exc:  # noqa: BLE001
        logger.warning("strategy %s raised %s", name, exc)
        return None, type(exc).__name__
    return produced, None


def run_strategy(name: str, image_bytes: bytes) -> bytes | None:
    """Run a single strategy. Cascade-flavored: errors are swallowed to None.

    Thin wrapper over `run_strategy_capturing` that throws away the error
    name. This is the primitive the cascade loop uses; the /crop endpoint
    calls `run_strategy_capturing` directly so it can surface crashes.
    """
    produced, _err = run_strategy_capturing(name, image_bytes)
    return produced


@dataclass(frozen=True)
class CropResult:
    """Outcome of the cascade.

    `returned_bytes_differ` is True when the server produced new bytes the
    client doesn't already have — i.e. the response should include
    `cropped_image_b64`. False for precropped (client uploaded those exact
    bytes) and passthrough (client uploaded the raw image).
    """

    image_bytes: bytes
    source: str
    returned_bytes_differ: bool
    orientation: OrientationResult
    classification: ClassifyResult


@dataclass(frozen=True)
class CropRejected:
    """Crop-only-mode outcome when the supplied crop fails validation.

    Only produced by the crop-only code path (no `image_bytes` uploaded).
    The handler translates this into a 422 response with a specific error
    code so the caller knows to retry with the original image attached.
    `reason` mirrors `ValidationResult.reason` or `"insufficient_text"`
    from the absolute text-count floor.
    """

    reason: str


def _try_stage(
    *,
    source: str,
    candidate_bytes: bytes,
    source_area_bytes: bytes,
    text_threshold: int,
    returned_bytes_differ: bool,
) -> CropResult | None:
    """Apply the uniform two-gate check to a candidate crop.

    Returns a winning CropResult if all gates pass, None otherwise.
    Caller can treat None as "advance to the next strategy."
    """
    check = is_plausible_crop(candidate_bytes, source_area_bytes=source_area_bytes)
    if not check.ok:
        logger.info("cascade: %s rejected by validator (%s)", source, check.reason)
        return None

    orient = detect_orientation(candidate_bytes)
    if orient.text_count < text_threshold:
        logger.info(
            "cascade: %s text_count=%d below threshold=%d, falling through",
            source,
            orient.text_count,
            text_threshold,
        )
        return None

    rotated = rotate_image_bytes(candidate_bytes, orient.rotation_degrees)
    classification = classify_card(rotated)

    return CropResult(
        image_bytes=candidate_bytes,
        source=source,
        returned_bytes_differ=returned_bytes_differ,
        orientation=orient,
        classification=classification,
    )


def _try_precropped_only(precropped_bytes: bytes) -> CropResult | CropRejected:
    """Crop-only mode: caller supplied only a crop, no original.

    Two gates still apply, adapted to the missing-original constraint:
      1. Geometry + blank-image (validator.is_plausible_crop with
         source_area_bytes=None — area-fraction is skipped since there's
         no source to compare against).
      2. Absolute text-count floor (MIN_ABSOLUTE_TEXT_COUNT) in place of the
         regression guard, since there's no baseline to regress from.

    On failure returns CropRejected so the handler can surface a specific
    4xx and the caller knows to retry with the original. On success runs
    orient → rotate → classify on the crop and returns a normal CropResult
    with source="precropped".
    """
    check = is_plausible_crop(precropped_bytes, source_area_bytes=None)
    if not check.ok:
        logger.info("crop_only: rejected by validator (%s)", check.reason)
        return CropRejected(reason=check.reason or "validator_failed")

    orient = detect_orientation(precropped_bytes)
    if orient.text_count < MIN_ABSOLUTE_TEXT_COUNT:
        logger.info(
            "crop_only: text_count=%d below absolute floor=%d",
            orient.text_count,
            MIN_ABSOLUTE_TEXT_COUNT,
        )
        return CropRejected(reason="insufficient_text")

    rotated = rotate_image_bytes(precropped_bytes, orient.rotation_degrees)
    classification = classify_card(rotated)

    return CropResult(
        image_bytes=precropped_bytes,
        source="precropped",
        returned_bytes_differ=False,
        orientation=orient,
        classification=classification,
    )


def crop(
    *,
    image_bytes: bytes | None,
    precropped_bytes: bytes | None,
) -> CropResult | CropRejected:
    """Run the crop cascade and return the winning result.

    Three input modes:
      - image-only: `image_bytes` set, `precropped_bytes` None → full cascade.
      - image+precropped: both set → cascade with precropped as stage 1,
        falls back to server strategies on the original if it's rejected.
      - **crop-only**: `image_bytes` None, `precropped_bytes` set → validate
        crop, run orient/classify on it, return CropResult or CropRejected.
        No fallback path — handler translates CropRejected to 422.

    When `precropped_bytes` is provided alongside `image_bytes`, that's tried
    first via `_try_stage`. When only `image_bytes` is present, it's used as
    the stage-1 candidate (slice-1 backward compat for callers who already
    cropped client-side).

    The baseline orient on `image_bytes` is computed up front — one extra
    Vision call relative to the old precropped-short-circuit path — so the
    text-count gate applies uniformly to every stage, including precropped.
    """
    # ── Crop-only mode ─────────────────────────────────────────────────
    # Caller opted into the "don't upload the original" fast path. No
    # fallback cascade is available; reject with a specific reason if
    # the crop doesn't pass the adapted two-gate check.
    if image_bytes is None:
        if precropped_bytes is None:
            raise ValueError("crop() requires at least one of image_bytes or precropped_bytes")
        return _try_precropped_only(precropped_bytes)

    # ── Baseline — used for the text-count threshold AND as the passthrough
    # fallback orient. Computed once, reused throughout.
    baseline_orient = detect_orientation(image_bytes)
    text_threshold = max(1, int(baseline_orient.text_count * MIN_CASCADE_TEXT_RATIO))
    logger.info(
        "cascade: baseline text_count=%d, threshold=%d",
        baseline_orient.text_count,
        text_threshold,
    )

    # ── Stage 1 — precropped (or raw image as candidate) through the uniform gate.
    # The client uploaded these exact bytes either way, so returned_bytes_differ
    # stays False regardless of which branch wins.
    stage1_candidate = precropped_bytes if precropped_bytes is not None else image_bytes
    result = _try_stage(
        source="precropped",
        candidate_bytes=stage1_candidate,
        source_area_bytes=image_bytes,
        text_threshold=text_threshold,
        returned_bytes_differ=False,
    )
    if result is not None:
        return result

    # ── Stages 2..N — server-side croppers through the same uniform gate.
    for source in STRATEGY_NAMES:
        produced = run_strategy(source, image_bytes)
        if produced is None:
            continue

        result = _try_stage(
            source=source,
            candidate_bytes=produced,
            source_area_bytes=image_bytes,
            text_threshold=text_threshold,
            returned_bytes_differ=True,
        )
        if result is not None:
            return result

    # ── Passthrough ─────────────────────────────────────────────────────
    # Unconditional fallback. Carries whatever orient+classify produced on
    # the raw image. May itself be empty-players / null card_number — the
    # honest "preprocess couldn't identify this card" signal.
    logger.info("cascade: falling through to passthrough")
    rotated = rotate_image_bytes(image_bytes, baseline_orient.rotation_degrees)
    passthrough_classification = classify_card(rotated)
    return CropResult(
        image_bytes=image_bytes,
        source="passthrough",
        returned_bytes_differ=False,
        orientation=baseline_orient,
        classification=passthrough_classification,
    )
