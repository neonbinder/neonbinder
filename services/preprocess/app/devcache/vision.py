"""Cache A: Vision `text_detection` answers (NEO-484).

**Key** = sha256 over, joined with `|`:

    "nb-devcache/vision" | VISION_CACHE_FORMAT | google-cloud-vision version
    | "TEXT_DETECTION" | sha256(the bytes sent to Vision)

The bytes are those `_shrink_for_vision` produced, i.e. exactly what Vision
receives, so a change to the shrink rule changes the key by itself. The request
carries nothing but the image (`vision.Image(content=...)`, no image context, no
feature list beyond what `text_detection` sets); `test_devcache_vision` pins
that shape, because a request option added later would otherwise be served an
answer cached without it. Bump `VISION_CACHE_FORMAT` whenever the request or
the value encoding changes.

**Value** = `AnnotateImageResponse.serialize(response)`, the proto wire bytes.

**Never stored:** a response whose `error.message` is set, and any exception.
Those are Vision's answer for this one call, not for the image.
"""

from __future__ import annotations

import hashlib
from importlib import metadata
from typing import Any, Final

from app.devcache import store

KIND: Final[str] = "vision"
KEY_NAMESPACE: Final[str] = "nb-devcache/vision"
VISION_CACHE_FORMAT: Final[int] = 1
FEATURE: Final[str] = "TEXT_DETECTION"
VISION_DIST: Final[str] = "google-cloud-vision"


def vision_version() -> str:
    """The installed google-cloud-vision version (raises when it cannot be read)."""
    return metadata.version(VISION_DIST)


def cache_key(sent: bytes) -> str:
    """The cache key for one Vision request whose image bytes are `sent`."""
    parts = (
        KEY_NAMESPACE,
        str(VISION_CACHE_FORMAT),
        vision_version(),
        FEATURE,
        hashlib.sha256(sent).hexdigest(),
    )
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def _response_type() -> Any:
    from google.cloud import vision

    return vision.AnnotateImageResponse


def serialize(response: Any) -> bytes:
    return _response_type().serialize(response)


def parse(payload: bytes) -> Any:
    """Payload bytes back to an `AnnotateImageResponse`; an error answer is rejected."""
    response = _response_type().deserialize(payload)
    if response.error.message:
        raise ValueError("cached Vision answer carries an error")
    return response


def lookup(sent: bytes) -> tuple[Any | None, store.Slot | None]:
    """`(response, None)` on a hit, else `(None, slot_or_None)`. Never raises."""
    return store.lookup(KIND, lambda: cache_key(sent), parse)


def remember(slot: store.Slot | None, response: Any) -> None:
    """Store a live answer, unless there is no slot or Vision answered with an error.

    Never raises: a response that cannot be serialized counts as a write failure.
    """
    if slot is None:
        return
    try:
        if response.error.message:
            return
        payload = serialize(response)
    except Exception as exc:  # noqa: BLE001 - never fail the request over the cache
        store.warn_limited(KIND, "serialize", exc)
        store.count("cache_write_failures")
        return
    slot.save(payload)
