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
    deskew          : OpenCV quad detect + perspective correction
    pil_trim_dark   : PIL blur + threshold + trim (card lighter than bg)
    pil_trim_light  : PIL blur + threshold + trim (card darker than bg)
    sam             : SAM ViT-B semantic segmentation
    haiku_bbox      : Anthropic Haiku bounding-box crop
    passthrough     : raw image forwarded unchanged

Why `deskew` leads. It has to run before SAM — it is orders of magnitude
cheaper (~93ms median on a 50MP photo vs SAM's 2-3s CPU inference) and
handles the tilted-card case SAM would otherwise be needed for. Placing it
before the PIL trims rather than after them is the measured call. The
reason it matters: the gates cannot tell a real crop from a non-crop,
because a whole 6144x8160 phone frame has aspect 0.753, only 5.4% off card
aspect, and covers 100% of itself. So it passes the validator, and
whichever stage runs first and returns it, wins. Across the 71 corpus
images over 3000px, running deskew last leaves 16 winners that are >92% of
the source (i.e. not crops at all); running it first leaves 13, turning
PXL_20260813_112644720, PXL_20250320_005433897 and PXL_20250817_184721488
from "the entire photo" into card crops at 0.3%, 2.8% and 3.2% aspect
error.

The cost of leading is that deskew gets first refusal on 156 scanner
images that pil_trim already handles well, so it is built to decline —
`deskew_crop` returns None whenever the best quad it finds is the image
frame, and again if the warped output lands further than
`MAX_OUTPUT_ASPECT_ERROR` from card aspect. Measured: of the 156 corpus
images at or under pil_trim's 3000px detection cap, all 156 produce
byte-identical cascade output with deskew in front.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from io import BytesIO

from PIL import Image

from app.classify import ClassifyResult, classify_card
from app.cropper import deskew, haiku_bbox, pil_trim, sam, tiebreak
from app.cropper._utils import rotate_image_bytes
from app.cropper.validator import (
    CARD_ASPECT_LANDSCAPE,
    CARD_ASPECT_PORTRAIT,
    is_plausible_crop,
)
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
    ("deskew", deskew, "deskew_crop"),
    ("pil_trim_dark", pil_trim, "trim_dark"),
    ("pil_trim_light", pil_trim, "trim_light"),
    ("sam", sam, "sam_crop"),
    ("haiku_bbox", haiku_bbox, "haiku_bbox_crop"),
]

# Public, ordered tuple of strategy names. Both the cascade and the
# /crop endpoint walk this — single source of truth for ordering.
STRATEGY_NAMES: tuple[str, ...] = tuple(name for name, _module, _attr in _STRATEGIES)

# The cheap, purely geometric strategies. These are SCORED against each other
# rather than raced, because no one of them is right on every card — which is
# the whole premise of having a cascade.
#
# First-acceptable-wins made that premise unreachable. `deskew` runs first, so
# any output of its that merely passed the gates won outright and the trims
# were never even computed. Measured on 2026-08-12-0012, deskew returned a
# 4.9%-off crop and pil_trim_dark's 2.0% crop never got a chance; on -0014,
# 2.5% displaced 0.2%. Neither is a gate failure — both crops are perfectly
# valid cards — the gates simply have nowhere to say "the next one is better".
#
# Scoring costs one extra Vision call per candidate gated, which is why the
# expensive classify is deferred to the winner alone (`_classify_winner`) and
# why SAM and Haiku stay out of this tier.
SCORED_STRATEGY_NAMES: tuple[str, ...] = ("deskew", "pil_trim_dark", "pil_trim_light")

# Aspect error leads the scoring, but only DECISIVELY: candidates within this
# band of the best score are treated as equally card-shaped, and the OUTERMOST
# (largest) one wins.
#
# Ranking on aspect error alone is not safe, because a crop that eats into the
# card can be better shaped than the correct one. Measured on 2026-08-11-0003,
# a tight scan where the right answer is "keep the frame": pil_trim_dark
# returns 103% of source at 1.5% off card aspect, while pil_trim_light returns
# 68% at 0.5%. Pure aspect ranking takes the 68% crop and eats a third of the
# card. Ten of sixty archive scans showed that same inversion.
#
# The band resolves it — 1.5pp covers the 1.0pp gap there, so both qualify and
# the larger wins — while still letting a decisively better shape through: on
# 2026-08-12-0012 pil_trim_dark's 2.0% beats deskew's 4.9% by well over the
# band, so it wins outright. Same policy, and same 1.5pp, as deskew's own
# ASPECT_SIGNIFICANCE_BAND, for the same reason.
CASCADE_ASPECT_SIGNIFICANCE_BAND = 0.015

# Expensive last resorts: ~2-3s of CPU inference for SAM, an Anthropic call for
# haiku_bbox. Raced in order and only reached when nothing cheap qualified, so
# scoring them would mean paying for both to compare them.
FALLBACK_STRATEGY_NAMES: tuple[str, ...] = tuple(
    name for name in STRATEGY_NAMES if name not in SCORED_STRATEGY_NAMES
)


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


def _passes_gates(
    *,
    source: str,
    candidate_bytes: bytes,
    source_area_bytes: bytes,
    text_threshold: int,
) -> OrientationResult | None:
    """The two gates, without the expensive classify step.

    Split out from `_try_stage` so several candidates can be gated and
    compared before paying for a single Anthropic classify — see
    `_best_of` and the scoring loop in `crop()`.
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
    return orient


def _classify_winner(
    *,
    source: str,
    candidate_bytes: bytes,
    orient: OrientationResult,
    returned_bytes_differ: bool,
) -> CropResult:
    """Rotate and classify the crop that won. Runs exactly once per request."""
    rotated = rotate_image_bytes(candidate_bytes, orient.rotation_degrees)
    classification = classify_card(rotated)
    return CropResult(
        image_bytes=candidate_bytes,
        source=source,
        returned_bytes_differ=returned_bytes_differ,
        orientation=orient,
        classification=classification,
    )


def crop_aspect_error(image_bytes: bytes) -> float:
    """Relative error of a crop's own aspect against the nearer card aspect.

    The comparison score for `_best_of`. It is the right one because it
    measures the thing the cascade is trying to produce — a rectangle the
    shape of a trading card — and it is already what every cropper is
    tuned against. Unreadable bytes score infinitely badly so they lose.
    """
    try:
        with Image.open(BytesIO(image_bytes)) as img:
            width, height = img.size
    except Exception:  # noqa: BLE001
        return float("inf")
    if height <= 0:
        return float("inf")
    ratio = width / height
    return min(
        abs(ratio - CARD_ASPECT_PORTRAIT) / CARD_ASPECT_PORTRAIT,
        abs(ratio - CARD_ASPECT_LANDSCAPE) / CARD_ASPECT_LANDSCAPE,
    )


def crop_area_fraction(image_bytes: bytes) -> float:
    """A crop's pixel area as a fraction of its own decoded size.

    Used only to compare candidates against each other, so the absolute
    value does not matter — a bigger crop of the same source keeps more of
    the card. Unreadable bytes score 0 so they lose.
    """
    try:
        with Image.open(BytesIO(image_bytes)) as img:
            return float(img.width * img.height)
    except Exception:  # noqa: BLE001
        return 0.0


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
    orient = _passes_gates(
        source=source,
        candidate_bytes=candidate_bytes,
        source_area_bytes=source_area_bytes,
        text_threshold=text_threshold,
    )
    if orient is None:
        return None
    return _classify_winner(
        source=source,
        candidate_bytes=candidate_bytes,
        orient=orient,
        returned_bytes_differ=returned_bytes_differ,
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
    first via `_try_stage`. When only `image_bytes` is present the cascade
    runs — the raw upload is NOT treated as an implicit crop candidate, since
    nothing about it could ever fail the gates (see the stage-1 comment).

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

    # ── Stage 2 — the cheap croppers, gated then SCORED against each other.
    # Every one of them clears the same gates; the best-shaped crop wins
    # rather than the first one to qualify. See SCORED_STRATEGY_NAMES.
    scored: list[tuple[float, str, bytes, OrientationResult, float]] = []
    for source in SCORED_STRATEGY_NAMES:
        produced = run_strategy(source, image_bytes)
        if produced is None:
            continue
        orient = _passes_gates(
            source=source,
            candidate_bytes=produced,
            source_area_bytes=image_bytes,
            text_threshold=text_threshold,
        )
        if orient is None:
            continue
        error = crop_aspect_error(produced)
        area = crop_area_fraction(produced)
        logger.info("cascade: %s qualifies, aspect_err=%.3f area_frac=%.3f", source, error, area)
        scored.append((error, source, produced, orient, area))

    if scored:
        lowest_error = min(entry[0] for entry in scored)
        contenders = [
            entry for entry in scored if entry[0] <= lowest_error + CASCADE_ASPECT_SIGNIFICANCE_BAND
        ]
        # Largest wins among contenders; ties keep SCORED_STRATEGY_NAMES order
        # so a dead heat resolves deterministically rather than by list luck.
        best_error, best_source, best_bytes, best_orient, _best_area = max(
            contenders,
            key=lambda entry: (entry[4], -SCORED_STRATEGY_NAMES.index(entry[1])),
        )

        # The band has declared these equally card-shaped, so geometry has
        # nothing left to say. Where they ALSO differ materially in what they
        # kept, a vision model can answer the question the proxies cannot —
        # "is the whole card here and nothing else". Strictly advisory: it
        # cannot overrule a decisive aspect win, it only reorders within the
        # band, and any failure keeps the geometric pick. Off by default;
        # see app/cropper/tiebreak.py.
        if len(contenders) > 1 and tiebreak.is_enabled():
            pairs = [(entry[1], entry[2]) for entry in contenders]
            if tiebreak.differ_materially(pairs):
                chosen = tiebreak.pick_best(pairs)
                if chosen is not None and chosen != best_source:
                    picked = next(entry for entry in contenders if entry[1] == chosen)
                    logger.info("cascade: tiebreak moved the winner %s -> %s", best_source, chosen)
                    best_error, best_source, best_bytes, best_orient, _best_area = picked
        logger.info(
            "cascade: %s wins (aspect_err=%.3f) from %d qualifying, %d within band",
            best_source,
            best_error,
            len(scored),
            len(contenders),
        )
        return _classify_winner(
            source=best_source,
            candidate_bytes=best_bytes,
            orient=best_orient,
            returned_bytes_differ=True,
        )

    # ── Stage 3 — expensive last resorts, raced in order.
    for source in FALLBACK_STRATEGY_NAMES:
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
