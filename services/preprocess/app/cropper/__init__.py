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
    precropped      : client-supplied crop (only when the client sent one)
    scan_metadata   : the scanner's own resolution proves the frame IS one
                      card, so there is no background to crop (NEO-191)
    tiered          : classical OpenCV + BiRefNet tiered pipeline (NEO-161)
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
from app.cropper import haiku_bbox, pil_trim, sam, scan_meta, tiered
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

# Crop-quality modes (NEO-173). "fast" runs the classical-only identity
# short-circuit before the cascade (skips BiRefNet on the pre-cropped
# majority); "strong" is the original tiered-first cascade. "fast" is the
# default because it never yields a worse crop — it only declines to escalate.
CROP_QUALITY_FAST = "fast"
CROP_QUALITY_STRONG = "strong"
CROP_QUALITIES: frozenset[str] = frozenset({CROP_QUALITY_FAST, CROP_QUALITY_STRONG})

# Source label for the NEO-191 scanner-metadata identity. Deliberately distinct
# from "tiered" even though both return the input untouched: they are different
# claims — "the pixels say this is already a card" versus "the device that made
# this file says the frame measures one card" — and only a distinct label lets
# `croppedSource` show which one carried an image.
SOURCE_SCAN_METADATA = "scan_metadata"

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
    ("tiered", tiered, "tiered_crop"),
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
            f"invalid strategy identifier: {identifier!r}; valid names: {list(STRATEGY_NAMES)}"
        )
    if isinstance(identifier, int):
        if 0 <= identifier < len(STRATEGY_NAMES):
            return STRATEGY_NAMES[identifier]
        raise UnknownStrategyError(
            f"strategy index {identifier} out of range; valid indices: 0..{len(STRATEGY_NAMES) - 1}"
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
    bytes), passthrough (client uploaded the raw image), and any strategy
    that returns the input untouched (tiered's identity guard).
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


@dataclass(frozen=True)
class CropDeclined:
    """FAST-role outcome (NEO-175): the classical fast path did not settle it.

    Produced ONLY when `crop()` is called with `escalate_only=True` — the
    posture of the FAST preprocess service (`PREPROCESS_ROLE=fast`), which
    deliberately runs the classical-only fast path and NEVER loads or calls a
    local model (BiRefNet / SAM). When the fast path neither wins nor is
    reached (any verdict that would otherwise fall through into the
    model-backed strategy loop), `crop()` returns this instead of running the
    heavy cascade. The `/process-entry` handler maps it to a 200 carrying
    `needs_escalation=true` and no crop result, telling Convex to re-enqueue
    the entry to the HEAVY service. `reason` is a stable machine string for
    logs/metrics — never a crop, never user data.
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
    crop_quality: str = CROP_QUALITY_FAST,
    escalate_only: bool = False,
) -> CropResult | CropRejected | CropDeclined:
    """Run the crop cascade and return the winning result.

    `escalate_only` (NEO-175) is the FAST preprocess role's no-fallthrough
    switch. When set, `crop()` runs the classical fast path (`crop_quality`
    must be ``"fast"`` for it to run at all) but, at the exact point where the
    cascade would otherwise fall through into the model-backed strategy loop
    (`tiered`/BiRefNet, `sam`, ...), it returns a `CropDeclined` instead. That
    guarantees the FAST role never loads or calls a local model: it either
    wins on the classical identity short-circuit or declines for the HEAVY
    service to escalate. `escalate_only` is inert in the crop-only and
    image+precropped modes — it only governs the image-only strategy loop.

    Three input modes:
      - image-only: `image_bytes` set, `precropped_bytes` None → full cascade.
      - image+precropped: both set → cascade with precropped as stage 1,
        falls back to server strategies on the original if it's rejected.
      - **crop-only**: `image_bytes` None, `precropped_bytes` set → validate
        crop, run orient/classify on it, return CropResult or CropRejected.
        No fallback path — handler translates CropRejected to 422.

    When `precropped_bytes` is provided alongside `image_bytes`, that's tried
    first via `_try_stage`. When only `image_bytes` is present the cascade
    runs — the raw upload is NOT treated as an implicit crop candidate, since
    nothing about it could ever fail the gates (see the stage-1 comment).

    `crop_quality` (NEO-173) tunes the image cascade, and ONLY it — precropped
    and crop-only modes are unaffected:
      - ``"fast"`` (default): two identity short-circuits run before the
        strategy loop. First `scan_meta.is_card_sized_scan` (NEO-191) reads the
        scanner's own resolution off the untouched upload — a frame that
        physically measures one 2.5x3.5in card has no background to crop, which
        settles ~95% of scanner intake with no pixel work at all. Then
        `tiered.fast_tiered_crop` runs a classical-only pass for sources whose
        metadata says nothing, returning the input untouched for an unambiguous
        pre-cropped card-aspect frame WITHOUT a BiRefNet inference. On any other
        verdict both decline and the cascade escalates to the full
        tiered/BiRefNet path below, so a `"fast"` crop is never worse than a
        `"strong"` one — the winning identity bytes are byte-identical to what
        `"strong"` produces.
      - ``"strong"``: the classical fast-path is skipped and the cascade runs
        tiered-first (BiRefNet) exactly as before.

    The baseline orient on `image_bytes` is computed up front — one extra
    Vision call relative to the old precropped-short-circuit path — so the
    text-count gate applies uniformly to every stage, including precropped.
    """
    if crop_quality not in CROP_QUALITIES:
        raise ValueError(f"unknown crop_quality {crop_quality!r}; valid: {sorted(CROP_QUALITIES)}")
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

    # ── Stage 1 — the client's own crop, and ONLY when it actually sent one.
    #
    # This used to fall back to `image_bytes` as the stage-1 candidate when no
    # `precropped` was supplied, which made the entire cascade unreachable for
    # the common case. Neither gate can reject a raw upload measured against
    # itself:
    #
    #   - `is_plausible_crop(image, source_area_bytes=image)` computes an area
    #     fraction of exactly 1.0 against MIN_AREA_FRACTION, and checks aspect
    #     against validator.ASPECT_TOLERANCE (±15%) — which a 3:4 phone photo
    #     clears at 5.4% off card aspect.
    #   - the text gate's threshold is 0.8x a baseline counted on those same
    #     bytes, so the candidate is compared against itself and always passes.
    #
    # Measured over the 227-image corpus, 184 uploads won at stage 1 and were
    # returned untouched — every 3:4 phone photo among them. That is the single
    # most common shape a user uploads, so in practice the croppers never ran.
    #
    # The deeper error was conflating two different questions. ASPECT_TOLERANCE
    # answers "is this a plausible crop?", and it was being used to answer "did
    # the user already crop this?" — which cannot be read off an aspect ratio at
    # all, since framing varies per user and per shot.
    #
    # A client that has genuinely already cropped says so by sending
    # `precropped`. Everyone else gets the cascade. `returned_bytes_differ`
    # stays False because the client uploaded these exact bytes.
    if precropped_bytes is not None:
        result = _try_stage(
            source="precropped",
            candidate_bytes=precropped_bytes,
            source_area_bytes=image_bytes,
            text_threshold=text_threshold,
            returned_bytes_differ=False,
        )
        if result is not None:
            return result

    # ── Fast-path identity short-circuits ───────────────────────────────
    # Two cheap ways to answer "is this frame already the card?", tried in
    # order of evidence quality before the model-backed cascade below.
    if crop_quality == CROP_QUALITY_FAST:
        # ── Scanner-metadata identity (NEO-191) ─────────────────────────
        # Ahead of the classical pass because it settles the same question
        # with strictly better evidence and no pixel work at all. When a
        # scanner reports a resolution, resolution x pixel dimensions is a
        # physical size, and a frame measuring one 2.5x3.5in card cannot
        # also contain a card plus background — so there is nothing to crop.
        #
        # This exists because the pixel path gets this case confidently
        # WRONG, not merely slowly: with the background already cropped away
        # the classical detector locks onto the printed inner panel and
        # shaves the card's own border at a clean card aspect that no later
        # gate rejects (see `scan_meta` and NEO-192).
        #
        # Reads `image_bytes` — the upload as the route received it. The one
        # thing upstream that rewrites those bytes is `apply_exif_orientation`,
        # which now carries the resolution across its transpose for exactly
        # this reason; any OTHER re-encode inserted between the upload and here
        # would drop the JFIF density and silently blind this check.
        #
        # The result still flows through the same `_try_stage` gates as
        # every other candidate, so nothing is bypassed; on the vanishing
        # chance they reject it, the cascade continues below.
        if scan_meta.is_card_sized_scan(image_bytes) is not None:
            result = _try_stage(
                source=SOURCE_SCAN_METADATA,
                candidate_bytes=image_bytes,
                source_area_bytes=image_bytes,
                text_threshold=text_threshold,
                returned_bytes_differ=False,
            )
            if result is not None:
                return result

        # ── Classical identity (NEO-173) ────────────────────────────────
        # The fallback for sources whose metadata says nothing: a phone
        # photo, a re-encoded upload, a scanner that records no resolution.
        # `fast_tiered_crop` returns the input untouched only for an
        # unambiguous card-aspect identity frame, else None (escalate), and
        # never produces a NEW crop — so it cannot ship a border-shaved or
        # un-deskewed result. A returned identity flows through the SAME
        # `_try_stage` gates as any tiered result, labelled `source="tiered"`
        # — indistinguishable from the "strong" identity outcome, just
        # cheaper. Anything it declines (every crop, every ambiguous or
        # deskew-needing frame) falls straight through to the full
        # tiered/BiRefNet cascade below.
        fast_bytes = tiered.fast_tiered_crop(image_bytes)
        if fast_bytes is not None:
            result = _try_stage(
                source="tiered",
                candidate_bytes=fast_bytes,
                source_area_bytes=image_bytes,
                text_threshold=text_threshold,
                returned_bytes_differ=fast_bytes != image_bytes,
            )
            if result is not None:
                return result

    # ── FAST-role escalation seam (NEO-175) ─────────────────────────────
    # The FAST preprocess service (`PREPROCESS_ROLE=fast`) sets escalate_only
    # so it runs ONLY the classical fast path above. Everything below — the
    # strategy loop's first stage is `tiered` (BiRefNet), followed by `sam` —
    # loads or calls a local model, which the FAST role must never do. When
    # the classical fast path did not settle the image, decline HERE so Convex
    # re-enqueues the entry to the HEAVY service, rather than falling through
    # into the model-backed cascade. Placed at the seam (not inside the loop)
    # so a new strategy can't accidentally run in the FAST role.
    if escalate_only:
        logger.info("cascade: escalate_only — declining for the heavy service")
        return CropDeclined(reason="fast_path_declined")

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
            # A strategy may return the input untouched (tiered's identity
            # guard: the upload already IS the card) — the client has those
            # exact bytes, so don't echo them back.
            returned_bytes_differ=produced != image_bytes,
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
