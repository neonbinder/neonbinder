"""Orientation detection via Google Cloud Vision text_detection.

Derives the dominant text angle from word bounding boxes in the image and
reports the counter-clockwise rotation (snapped to one of 0/90/180/270)
required to make the text upright.

Coordinate conventions used here:
- Image pixel coords: +x right, +y down (standard raster).
- Vision returns `bounding_poly.vertices` in text-local order [TL, TR, BR, BL].
  So `vertices[1] - vertices[0]` is the top edge of the word, in image pixels.
- `atan2(dy, dx)` of that edge, in degrees mod 360, equals the CW rotation of
  the text relative to upright. By symmetry of 90-snapping, this number also
  equals the CCW rotation that must be applied to the image to undo it.
"""

from __future__ import annotations

import logging
import math
import threading
from collections import Counter
from dataclasses import dataclass

from google.api_core.exceptions import ServiceUnavailable
from google.cloud import vision

from app.timing import increment_current
from app.vision_card_number import vision_card_number

logger = logging.getLogger(__name__)

# One Vision client per process (NEO-315). Building an ImageAnnotatorClient
# per call re-resolved ADC and opened a fresh gRPC channel on every orient —
# up to three times per image. The client is thread-safe, so a single lazily
# built instance serves every concurrent request; the lock guards its
# construction (a burst of cold requests builds exactly one) and its
# replacement (below).
#
# Reconnect-and-retry-once. Once, on the dev heavy revision, a text_detection
# on the shared client failed with `ServiceUnavailable: 503 Stream removed
# (recvmsg:Connection reset by peer)` — gRPC UNAVAILABLE on the transport —
# and /process returned 502. It has not reproduced on demand. The
# `text_detection` helper passes `retry=None` down to the GAPIC call, which
# switches OFF the library's own UNAVAILABLE retry, so a single dropped
# stream used to fail the whole request. So `detect_orientation` wraps ONLY
# the text_detection RPC: on `ServiceUnavailable`, and nothing else, it
# discards the shared client, builds a fresh one, and retries exactly once. A
# second failure propagates unchanged.
#
# Deliberately NOT retried: an in-body `response.error` (per-image errors,
# RESOURCE_EXHAUSTED quota included — a product decision, no Vision retries
# for that), DeadlineExceeded, ResourceExhausted, InvalidArgument, or any
# other exception. Those are not "the channel died under us", and a retry
# would only add latency or spend quota.
#
# Each reconnect bumps `vision_reconnects` on the request's
# `process_entry_timing` line and logs one warning naming the exception class.
_client: vision.ImageAnnotatorClient | None = None
_client_lock = threading.Lock()


def get_vision_client() -> vision.ImageAnnotatorClient:
    """Return the process-wide Vision client, building it on first use."""
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = vision.ImageAnnotatorClient()
    return _client


def _replace_vision_client(stale: vision.ImageAnnotatorClient) -> vision.ImageAnnotatorClient:
    """Swap out `stale` for a fresh shared client and return the current one.

    Only replaces when the shared client is still the instance that failed:
    when several requests hit UNAVAILABLE on the same dead channel, the first
    one through the lock rebuilds and the rest pick up its fresh client
    instead of each building (and discarding) another. The stale client is
    not closed explicitly: other in-flight requests may still hold it, and a
    closed channel would fail them with an error this path does not retry.
    It is released when the last reference goes.
    """
    global _client
    with _client_lock:
        if _client is stale or _client is None:
            _client = vision.ImageAnnotatorClient()
        return _client


@dataclass(frozen=True)
class OrientationResult:
    """Outcome of orientation detection.

    rotation_degrees: CCW rotation to apply to the image to make text upright,
        one of {0, 90, 180, 270}. When `text_count == 0` this field is 0 but
        should be treated as "undetermined" rather than "confidently upright".
    confidence: Fraction (0..1) of detected words whose bounding-box angle
        agrees with the winning rotation bucket.
    text_count: Total number of words considered for the vote.
    vision_card_number: The card number read from this same response, only
        when it is definitive (`app.vision_card_number`, NEO-327); else None.
        In-process only: it is never serialised, so a baseline orient that
        crossed the wire from the FAST role carries None and Haiku's number
        stands.
    """

    rotation_degrees: int
    confidence: float
    text_count: int
    vision_card_number: str | None = None


def _edge_angle_degrees(v0, v1) -> float:
    dx = v1.x - v0.x
    dy = v1.y - v0.y
    return math.degrees(math.atan2(dy, dx)) % 360


def _snap_to_quadrant(degrees: float) -> int:
    return int(round(degrees / 90) * 90) % 360


def _text_detection(image_bytes: bytes, client: vision.ImageAnnotatorClient | None):
    """The one Vision RPC, with the shared-client reconnect (module note)."""
    image = vision.Image(content=image_bytes)
    if client is not None:
        return client.text_detection(image=image)

    annotator = get_vision_client()
    try:
        return annotator.text_detection(image=image)
    except ServiceUnavailable as exc:
        # Class name only: the message can carry peer addresses, and nothing
        # about the image or the request belongs in this line.
        logger.warning(
            "vision: %s on the shared client; reconnecting and retrying once",
            type(exc).__name__,
        )
        increment_current("vision_reconnects")
    # Retried outside the `except` so a second failure propagates as itself,
    # not chained under the first.
    return _replace_vision_client(annotator).text_detection(image=image)


def detect_orientation(
    image_bytes: bytes,
    *,
    client: vision.ImageAnnotatorClient | None = None,
) -> OrientationResult:
    """Detect the rotation needed to make text in the image upright.

    In production the process-wide client from `get_vision_client` is used
    (ADC from the Cloud Run runtime service account), with the
    reconnect-and-retry-once on `ServiceUnavailable` described in the module
    note. The `client` kwarg is injected in tests; an injected client is
    called exactly once and never rebuilt or retried, so a test that injects
    one sees every exception as raised.
    """
    response = _text_detection(image_bytes, client)

    if response.error.message:
        raise RuntimeError(f"vision api error: {response.error.message}")

    # text_annotations[0] is the full-document bounding poly; word-level
    # entries start at index 1. An image with no text returns an empty list.
    word_annotations = list(response.text_annotations[1:])
    if not word_annotations:
        return OrientationResult(rotation_degrees=0, confidence=0.0, text_count=0)

    buckets: Counter[int] = Counter()
    for annotation in word_annotations:
        vertices = list(annotation.bounding_poly.vertices)
        if len(vertices) < 2:
            continue
        angle = _edge_angle_degrees(vertices[0], vertices[1])
        buckets[_snap_to_quadrant(angle)] += 1

    if not buckets:
        return OrientationResult(rotation_degrees=0, confidence=0.0, text_count=0)

    winning_angle, winning_count = buckets.most_common(1)[0]
    total = sum(buckets.values())
    return OrientationResult(
        rotation_degrees=winning_angle,
        confidence=winning_count / total,
        text_count=total,
        vision_card_number=_definitive_card_number(response),
    )


def _definitive_card_number(response) -> str | None:
    """Never lets the card-number read fail the orient it rides on."""
    try:
        return vision_card_number(response)
    except Exception:  # noqa: BLE001 — an unexpected response shape means "not definitive"
        logger.warning("orient: vision card number read failed; using the classifier's")
        return None
