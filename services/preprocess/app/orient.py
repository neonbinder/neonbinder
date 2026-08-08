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

import math
from collections import Counter
from dataclasses import dataclass

from google.cloud import vision


@dataclass(frozen=True)
class OrientationResult:
    """Outcome of orientation detection.

    rotation_degrees: CCW rotation to apply to the image to make text upright,
        one of {0, 90, 180, 270}. When `text_count == 0` this field is 0 but
        should be treated as "undetermined" rather than "confidently upright".
    confidence: Fraction (0..1) of detected words whose bounding-box angle
        agrees with the winning rotation bucket.
    text_count: Total number of words considered for the vote.
    """

    rotation_degrees: int
    confidence: float
    text_count: int


def _edge_angle_degrees(v0, v1) -> float:
    dx = v1.x - v0.x
    dy = v1.y - v0.y
    return math.degrees(math.atan2(dy, dx)) % 360


def _snap_to_quadrant(degrees: float) -> int:
    return int(round(degrees / 90) * 90) % 360


def detect_orientation(
    image_bytes: bytes,
    *,
    client: vision.ImageAnnotatorClient | None = None,
) -> OrientationResult:
    """Detect the rotation needed to make text in the image upright.

    The `client` kwarg is injected in tests; in production it defaults to a
    fresh ImageAnnotatorClient, which picks up ADC from the Cloud Run runtime
    service account.
    """
    annotator = client or vision.ImageAnnotatorClient()
    response = annotator.text_detection(image=vision.Image(content=image_bytes))

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
    )
