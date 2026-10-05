"""Per-request stage timings for `/process-entry` (NEO-315).

One `Timings` object is created per `/process-entry` request and threaded
explicitly through the route and `cropper.crop()`. It is never a module
global: the FAST role runs several requests concurrently in one process, so a
shared accumulator would mix their numbers.

The one place an explicit parameter cannot reach is a leaf deep inside a
strategy whose signature is fixed (`tiered.birefnet_mask` sits under
`tiered_crop(image_bytes)`, which tests monkeypatch with one-argument
lambdas). For that, `crop()` binds the request's `Timings` to a `ContextVar`
for the duration of the call (`bound`), and the leaf adds to it through
`measure_current`. A ContextVar is per-thread / per-copied-context, and
Starlette runs each sync handler inside its own copied context, so concurrent
requests never see each other's object. With nothing bound, `measure_current`
is a no-op, so `/process`, `/crop` and the unit tests pay nothing.
`increment_current` is the counter twin, used by `app.orient` to record a
Vision reconnect from inside `detect_orientation`.

`emit` writes ONE JSON line per request through the dedicated `timing`
logger: a plain `%(message)s` handler on stdout with `propagate=False`, so the
line reaches Cloud Logging as bare JSON (parsed into `jsonPayload`) instead of
being prefixed by the root handler's `LEVEL name:` format. The payload is
numbers, booleans and short machine labels only: never image content, object
paths, user or job identifiers, or keys.
"""

from __future__ import annotations

import json
import logging
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field

TIMING_LOGGER_NAME = "timing"
TIMING_MSG = "process_entry_timing"

# Fields that accumulate milliseconds. Kept as a tuple so `measure` can reject
# a typo'd field name instead of silently creating a new attribute.
MS_FIELDS: tuple[str, ...] = (
    "gcs_ms",
    "exif_ms",
    "dhash_ms",
    "vision_ms",
    "classical_ms",
    "quad_ms",
    "birefnet_ms",
    "sam_ms",
    "haiku_bbox_ms",
    "classify_ms",
    "rotate_ms",
    "write_ms",
)

# Fields that count events. `increment_current` accepts only these, for the
# same reason `measure` checks MS_FIELDS.
COUNT_FIELDS: tuple[str, ...] = ("vision_reconnects",)


def _build_timing_logger() -> logging.Logger:
    """The dedicated, non-propagating JSON-line logger.

    Pinned at INFO independently of `LOG_LEVEL`: this line is the measurement,
    one per entry, and turning the chatty `app.*` routing logs down to WARNING
    must not also switch off the numbers. The handler guard keeps a re-import
    (uvicorn reload) from attaching a second handler and doubling every line.
    """
    timing_logger = logging.getLogger(TIMING_LOGGER_NAME)
    timing_logger.setLevel(logging.INFO)
    timing_logger.propagate = False
    if not timing_logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter("%(message)s"))
        timing_logger.addHandler(handler)
    return timing_logger


timing_logger = _build_timing_logger()


@dataclass
class Timings:
    """Mutable accumulator for one request. Not shared, not thread-safe by design."""

    role: str | None = None
    index: int | None = None
    gcs_ms: float = 0.0
    exif_ms: float = 0.0
    dhash_ms: float = 0.0
    vision_calls: int = 0
    vision_ms: float = 0.0
    # Vision RPCs this request retried on a rebuilt client after the shared
    # one failed with ServiceUnavailable (see `app.orient`). Normally 0.
    vision_reconnects: int = 0
    # Non-model pixel work: scan-metadata check, the classical fast path, the
    # classical share of `tiered` (its time minus BiRefNet), and pil_trim.
    classical_ms: float = 0.0
    # The FAST role's quad detector + content checks (NEO-320), including its
    # warp; kept apart from `classical_ms` so its cost is visible on its own.
    quad_ms: float = 0.0
    birefnet_ms: float = 0.0
    sam_ms: float = 0.0
    haiku_bbox_ms: float = 0.0
    classify_ms: float = 0.0
    # True when any classify call on this request needed its parse retry.
    classify_retried: bool = False
    rotate_ms: float = 0.0
    write_ms: float = 0.0
    source: str | None = None
    escalated: bool = False
    baseline_supplied: bool = False
    # Frequency signals for the later "is Haiku bbox worth keeping" decision:
    # did the cascade reach that strategy at all, and did it win.
    haiku_bbox_reached: bool = False
    haiku_bbox_won: bool = False
    # NEO-327: which read supplied the result's card number: "vision" (a
    # definitive OCR read), "haiku", or None when neither found one.
    card_number_source: str | None = None
    started: float = field(default_factory=time.perf_counter)

    @contextmanager
    def measure(self, name: str) -> Iterator[None]:
        """Add the wall time of the `with` body to the `name` ms field."""
        if name not in MS_FIELDS:
            raise ValueError(f"unknown timing field {name!r}")
        t0 = time.perf_counter()
        try:
            yield
        finally:
            setattr(self, name, getattr(self, name) + (time.perf_counter() - t0) * 1000.0)

    def payload(self) -> dict[str, object]:
        """The JSON-line body. Millisecond fields are rounded to whole ms."""
        body: dict[str, object] = {
            "msg": TIMING_MSG,
            "role": self.role,
            "index": self.index,
        }
        for name in (
            "gcs_ms",
            "exif_ms",
            "dhash_ms",
        ):
            body[name] = round(getattr(self, name))
        body["vision_calls"] = self.vision_calls
        body["vision_ms"] = round(self.vision_ms)
        body["vision_reconnects"] = self.vision_reconnects
        for name in (
            "classical_ms",
            "quad_ms",
            "birefnet_ms",
            "sam_ms",
            "haiku_bbox_ms",
            "classify_ms",
        ):
            body[name] = round(getattr(self, name))
        body["classify_retried"] = self.classify_retried
        body["rotate_ms"] = round(self.rotate_ms)
        body["write_ms"] = round(self.write_ms)
        body["total_ms"] = round((time.perf_counter() - self.started) * 1000.0)
        body["source"] = self.source
        body["escalated"] = self.escalated
        body["baseline_supplied"] = self.baseline_supplied
        body["haiku_bbox_reached"] = self.haiku_bbox_reached
        body["haiku_bbox_won"] = self.haiku_bbox_won
        body["card_number_source"] = self.card_number_source
        return body

    def emit(self) -> None:
        timing_logger.info(json.dumps(self.payload(), separators=(",", ":")))


_current: ContextVar[Timings | None] = ContextVar("preprocess_timings", default=None)


@contextmanager
def bound(timings: Timings) -> Iterator[Timings]:
    """Make `timings` visible to `measure_current` for the `with` body."""
    token = _current.set(timings)
    try:
        yield timings
    finally:
        _current.reset(token)


def increment_current(name: str) -> None:
    """Add one to the `name` counter on whatever request is bound; a no-op when none is."""
    if name not in COUNT_FIELDS:
        raise ValueError(f"unknown counter field {name!r}")
    timings = _current.get()
    if timings is not None:
        setattr(timings, name, getattr(timings, name) + 1)


@contextmanager
def measure_current(name: str) -> Iterator[None]:
    """`Timings.measure` on whatever request is bound; a no-op when none is."""
    timings = _current.get()
    if timings is None:
        yield
        return
    with timings.measure(name):
        yield
