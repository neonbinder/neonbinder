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
    quad            : the FAST role's four-corner detector + perspective warp,
                      accepted only when its pixel content checks agree
                      (NEO-320)
    tiered          : classical OpenCV + BiRefNet tiered pipeline (NEO-161)
    pil_trim_dark   : PIL blur + threshold + trim (card lighter than bg)
    pil_trim_light  : PIL blur + threshold + trim (card darker than bg)
    sam             : SAM ViT-B semantic segmentation
    haiku_bbox      : Anthropic Haiku bounding-box crop
    passthrough     : raw image forwarded unchanged
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, replace

from app import timing
from app.classify import ClassifyResult, classify_card
from app.cropper import haiku_bbox, pil_trim, quad, sam, scan_meta, tiered
from app.cropper._utils import rotate_image_bytes
from app.cropper.validator import is_plausible_crop
from app.orient import OrientationResult, detect_orientation
from app.timing import Timings

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

# Source label for the NEO-320 quad crop: a NEW crop (warped from four
# detected corners), unlike the two identity labels above, so a winning quad
# always returns its bytes to the client.
SOURCE_QUAD = "quad"

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

# Which `Timings` field each strategy's wall time lands in (NEO-315). `tiered`
# is special-cased in `_timed_strategy`: its BiRefNet share is recorded by
# `tiered.birefnet_mask` itself, and only the remainder counts as classical.
_STRATEGY_TIMING_FIELD: dict[str, str] = {
    "tiered": "classical_ms",
    "pil_trim_dark": "classical_ms",
    "pil_trim_light": "classical_ms",
    "sam": "sam_ms",
    "haiku_bbox": "haiku_bbox_ms",
}


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

    `rotated_bytes` (NEO-315) is `image_bytes` already rotated by
    `orientation.rotation_degrees` — the exact bytes classify saw. It is the
    same object as `image_bytes` when the rotation is 0. `/process-entry`
    writes it as the output so the winner is not rotated (decoded and
    re-encoded) a second time. None only for a result built outside the
    cascade (test doubles); consumers fall back to rotating `image_bytes`.
    """

    image_bytes: bytes
    source: str
    returned_bytes_differ: bool
    orientation: OrientationResult
    classification: ClassifyResult
    rotated_bytes: bytes | None = None


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

    `baseline` (NEO-315) is the Vision orient of the whole image this request
    already paid for. `/process-entry` returns it on the decline so Convex can
    hand it to the HEAVY service, which then skips its own baseline call.
    """

    reason: str
    baseline: OrientationResult | None = None


def _orient(candidate_bytes: bytes, timings: Timings) -> OrientationResult:
    """One counted, timed Vision call.

    Looks `detect_orientation` up as a module global at call time, so the
    tests' `monkeypatch.setattr(cropper, "detect_orientation", ...)` applies.
    """
    timings.vision_calls += 1
    with timings.measure("vision_ms"):
        return detect_orientation(candidate_bytes)


def _rotate(candidate_bytes: bytes, degrees: int, timings: Timings) -> bytes:
    with timings.measure("rotate_ms"):
        return rotate_image_bytes(candidate_bytes, degrees)


def _classify(rotated: bytes, timings: Timings) -> ClassifyResult:
    with timings.measure("classify_ms"):
        result = classify_card(rotated)
    if getattr(result, "retried", False):
        timings.classify_retried = True
    return result


def resolve_card_number(
    orientation: OrientationResult, classification: ClassifyResult
) -> tuple[ClassifyResult, str | None]:
    """Pick the card number (NEO-327): Vision's when definitive, else Haiku's.

    Vision's read (`OrientationResult.vision_card_number`) is used only when
    it is definitive and the classifier did not call this image a front: a
    front's printed numbers are jerseys and logos, never the card number.
    Returns the classification to report and the winning source, "vision",
    "haiku", or None when neither has a number.
    """
    vision_number = getattr(orientation, "vision_card_number", None)
    if vision_number is not None and classification.side != "front":
        if vision_number != classification.card_number:
            logger.info(
                "classify: card number from vision=%s over haiku=%s",
                vision_number,
                classification.card_number,
            )
        return replace(classification, card_number=vision_number), "vision"
    if classification.card_number is not None:
        return classification, "haiku"
    return classification, None


def _classify_oriented(
    rotated: bytes, orientation: OrientationResult, timings: Timings
) -> ClassifyResult:
    """Classify, then settle the card number against the orient's Vision read."""
    classification, source = resolve_card_number(orientation, _classify(rotated, timings))
    timings.card_number_source = source
    return classification


def _timed_strategy(source: str, image_bytes: bytes, timings: Timings) -> bytes | None:
    """`run_strategy` with its wall time booked to the strategy's field.

    For `tiered`, BiRefNet's own share is booked to `birefnet_ms` by
    `tiered.birefnet_mask` (through the bound ContextVar), so only the rest of
    the strategy's time counts as classical.
    """
    if source == "haiku_bbox":
        timings.haiku_bbox_reached = True
    field_name = _STRATEGY_TIMING_FIELD.get(source, "classical_ms")
    birefnet_before = timings.birefnet_ms
    t0 = time.perf_counter()
    try:
        return run_strategy(source, image_bytes)
    finally:
        elapsed = (time.perf_counter() - t0) * 1000.0
        if source == "tiered":
            elapsed -= timings.birefnet_ms - birefnet_before
        setattr(timings, field_name, getattr(timings, field_name) + max(0.0, elapsed))


def _try_stage(
    *,
    source: str,
    candidate_bytes: bytes,
    source_area_bytes: bytes,
    text_threshold: int,
    returned_bytes_differ: bool,
    baseline_orient: OrientationResult | None = None,
    timings: Timings | None = None,
) -> CropResult | None:
    """Apply the uniform two-gate check to a candidate crop.

    Returns a winning CropResult if all gates pass, None otherwise.
    Caller can treat None as "advance to the next strategy."

    `baseline_orient` (NEO-315) is the orient `crop()` already computed for the
    whole image. When the candidate IS that image — the same object, which is
    what every identity outcome returns (scan metadata, the classical fast
    path, and `tiered`'s identity guard all hand back `image_bytes` itself) —
    the baseline is reused instead of sending byte-identical bytes to Vision a
    second time. `source_area_bytes` is always the original image here, so the
    identity check is `candidate_bytes is source_area_bytes`.
    """
    if timings is None:
        timings = Timings()
    check = is_plausible_crop(candidate_bytes, source_area_bytes=source_area_bytes)
    if not check.ok:
        logger.info("cascade: %s rejected by validator (%s)", source, check.reason)
        return None

    if baseline_orient is not None and candidate_bytes is source_area_bytes:
        orient = baseline_orient
    else:
        orient = _orient(candidate_bytes, timings)
    if orient.text_count < text_threshold:
        logger.info(
            "cascade: %s text_count=%d below threshold=%d, falling through",
            source,
            orient.text_count,
            text_threshold,
        )
        return None

    rotated = _rotate(candidate_bytes, orient.rotation_degrees, timings)
    classification = _classify_oriented(rotated, orient, timings)

    return CropResult(
        image_bytes=candidate_bytes,
        source=source,
        returned_bytes_differ=returned_bytes_differ,
        orientation=orient,
        classification=classification,
        rotated_bytes=rotated,
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
    classification, _source = resolve_card_number(orient, classify_card(rotated))

    return CropResult(
        image_bytes=precropped_bytes,
        source="precropped",
        returned_bytes_differ=False,
        orientation=orient,
        classification=classification,
        rotated_bytes=rotated,
    )


def crop(
    *,
    image_bytes: bytes | None,
    precropped_bytes: bytes | None,
    crop_quality: str = CROP_QUALITY_FAST,
    escalate_only: bool = False,
    baseline: OrientationResult | None = None,
    skip_fast_path: bool = False,
    timings: Timings | None = None,
) -> CropResult | CropRejected | CropDeclined:
    """Run the crop cascade and return the winning result.

    `baseline` (NEO-315) is a Vision orient of `image_bytes` the caller
    already holds — the FAST service's, handed to the HEAVY service on
    escalation, over byte-identical bytes. When supplied, the up-front
    `detect_orientation(image_bytes)` is skipped and it is used everywhere the
    computed baseline would have been: the text threshold, identity-stage
    reuse, and the passthrough. Ignored in crop-only mode.

    `skip_fast_path` (NEO-315) skips every fast-path stage (scan metadata,
    `fast_tiered_crop` and the NEO-320 quad crop) and goes straight to the
    strategy loop. The HEAVY route sets it when the request carries a FAST
    decline's baseline: FAST already ran those exact stages on byte-identical
    bytes and declined. The three detectors are pure functions of the bytes
    (scan_meta reads header metadata; the classical pass and `quad_crop` are
    deterministic OpenCV with no env, role or model input). Their gates are
    not all deterministic: the identity stages reuse the supplied baseline,
    but a quad crop is new bytes and its gate makes its own Vision call,
    which can vary or fail. Skipping is still right — HEAVY's strategy loop
    is the slower, stronger answer to the same frame, not a retry of FAST.

    `timings` (NEO-315) is the caller's per-request accumulator; stage times
    and the Vision call count are added to it. Omitted, a throwaway one is
    used, so `/process` and the unit tests are unaffected.

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
        verdict both decline. Then `quad.quad_crop` (NEO-320) looks for one
        card's four corners and warps it flat; its crop is offered to the
        gates only when every pixel content check agrees (single card, outside
        is background, inside is card, edges supported), and any doubt
        declines. Whatever none of the three settles escalates to the full
        tiered/BiRefNet path below.
      - ``"strong"``: the classical fast-path is skipped and the cascade runs
        tiered-first (BiRefNet) exactly as before.

    The baseline orient on `image_bytes` is computed up front — one extra
    Vision call relative to the old precropped-short-circuit path — so the
    text-count gate applies uniformly to every stage, including precropped.
    """
    if crop_quality not in CROP_QUALITIES:
        raise ValueError(f"unknown crop_quality {crop_quality!r}; valid: {sorted(CROP_QUALITIES)}")
    if timings is None:
        timings = Timings()
    # Bind for the leaves that cannot take a parameter (BiRefNet inside
    # `tiered_crop`); see `app.timing`.
    with timing.bound(timings):
        return _crop(
            image_bytes=image_bytes,
            precropped_bytes=precropped_bytes,
            crop_quality=crop_quality,
            escalate_only=escalate_only,
            baseline=baseline,
            skip_fast_path=skip_fast_path,
            timings=timings,
        )


def _crop(
    *,
    image_bytes: bytes | None,
    precropped_bytes: bytes | None,
    crop_quality: str,
    escalate_only: bool,
    baseline: OrientationResult | None,
    skip_fast_path: bool,
    timings: Timings,
) -> CropResult | CropRejected | CropDeclined:
    """The body of `crop()`, run with `timings` bound. See `crop()`."""
    # ── Crop-only mode ─────────────────────────────────────────────────
    # Caller opted into the "don't upload the original" fast path. No
    # fallback cascade is available; reject with a specific reason if
    # the crop doesn't pass the adapted two-gate check.
    if image_bytes is None:
        if precropped_bytes is None:
            raise ValueError("crop() requires at least one of image_bytes or precropped_bytes")
        return _try_precropped_only(precropped_bytes)

    # ── Baseline — used for the text-count threshold AND as the passthrough
    # fallback orient. Computed once (or supplied by the caller), reused
    # throughout — including by any identity stage, whose candidate is these
    # same bytes (see `_try_stage`).
    baseline_orient = baseline if baseline is not None else _orient(image_bytes, timings)
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
            timings=timings,
        )
        if result is not None:
            return result

    # ── Fast path ───────────────────────────────────────────────────────
    # Two cheap ways to answer "is this frame already the card?", tried in
    # order of evidence quality, then the quad crop for everything else —
    # all before the model-backed cascade below. Skipped when the caller
    # already ran them and declined (`skip_fast_path`).
    if skip_fast_path:
        logger.info("cascade: fast path already declined upstream, skipping to strategies")
    if crop_quality == CROP_QUALITY_FAST and not skip_fast_path:
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
        with timings.measure("classical_ms"):
            card_sized_scan = scan_meta.is_card_sized_scan(image_bytes)
        if card_sized_scan is not None:
            result = _try_stage(
                source=SOURCE_SCAN_METADATA,
                candidate_bytes=image_bytes,
                source_area_bytes=image_bytes,
                text_threshold=text_threshold,
                returned_bytes_differ=False,
                baseline_orient=baseline_orient,
                timings=timings,
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
        with timings.measure("classical_ms"):
            fast_bytes = tiered.fast_tiered_crop(image_bytes)
        if fast_bytes is not None:
            result = _try_stage(
                source="tiered",
                candidate_bytes=fast_bytes,
                source_area_bytes=image_bytes,
                text_threshold=text_threshold,
                returned_bytes_differ=fast_bytes != image_bytes,
                baseline_orient=baseline_orient,
                timings=timings,
            )
            if result is not None:
                return result

        # ── Quad crop (NEO-320) ─────────────────────────────────────────
        # Every frame the identity checks above did not accept: find one
        # card's four corners and warp it flat, in well under a second where
        # the HEAVY role's BiRefNet pass costs ~40 s. Placed AFTER both
        # identity checks because a frame that already IS the card has no
        # background to find — a quad there is the card's printed border.
        #
        # Nothing here asks where the image came from (no device, resolution
        # or metadata test): `quad_crop` decides on the pixels alone and
        # declines, with a named reason, whenever its content checks are not
        # all satisfied. A crop it does return still has to clear the same
        # `_try_stage` validator and Vision text gate as every other stage.
        with timings.measure("quad_ms"):
            quad_result = quad.quad_crop(image_bytes)
        if quad_result.crop_bytes is None:
            logger.info("fast: quad declined reason=%s", quad_result.reason)
        else:
            # The crop is a NEW image, so its gate makes a Vision call of its
            # own (unlike the identity stages, which reuse the baseline). A
            # failure there must not turn into a retryable 502 for an entry
            # HEAVY can still settle: decline the quad, keep the baseline, and
            # fall through exactly as if the quad had never offered a crop.
            try:
                result = _try_stage(
                    source=SOURCE_QUAD,
                    candidate_bytes=quad_result.crop_bytes,
                    source_area_bytes=image_bytes,
                    text_threshold=text_threshold,
                    returned_bytes_differ=True,
                    baseline_orient=baseline_orient,
                    timings=timings,
                )
            except Exception:
                logger.exception("fast: quad declined reason=gates_error")
                result = None
            else:
                if result is None:
                    logger.info("fast: quad declined reason=gates")
            if result is not None:
                logger.info("fast: quad accepted")
                return result

    # ── FAST-role escalation seam (NEO-175) ─────────────────────────────
    # The FAST preprocess service (`PREPROCESS_ROLE=fast`) sets escalate_only
    # so it runs ONLY the classical fast path above (scan metadata, classical
    # identity, quad crop — none of them loads a model). Everything below — the
    # strategy loop's first stage is `tiered` (BiRefNet), followed by `sam` —
    # loads or calls a local model, which the FAST role must never do. When
    # the classical fast path did not settle the image, decline HERE so Convex
    # re-enqueues the entry to the HEAVY service, rather than falling through
    # into the model-backed cascade. Placed at the seam (not inside the loop)
    # so a new strategy can't accidentally run in the FAST role.
    if escalate_only:
        logger.info("cascade: escalate_only — declining for the heavy service")
        return CropDeclined(reason="fast_path_declined", baseline=baseline_orient)

    # ── Stages 2..N — server-side croppers through the same uniform gate.
    for source in STRATEGY_NAMES:
        produced = _timed_strategy(source, image_bytes, timings)
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
            baseline_orient=baseline_orient,
            timings=timings,
        )
        if result is not None:
            if source == "haiku_bbox":
                timings.haiku_bbox_won = True
            return result

    # ── Passthrough ─────────────────────────────────────────────────────
    # Unconditional fallback. Carries whatever orient+classify produced on
    # the raw image. May itself be empty-players / null card_number — the
    # honest "preprocess couldn't identify this card" signal.
    logger.info("cascade: falling through to passthrough")
    rotated = _rotate(image_bytes, baseline_orient.rotation_degrees, timings)
    passthrough_classification = _classify_oriented(rotated, baseline_orient, timings)
    return CropResult(
        image_bytes=image_bytes,
        source="passthrough",
        returned_bytes_differ=False,
        orientation=baseline_orient,
        classification=passthrough_classification,
        rotated_bytes=rotated,
    )
