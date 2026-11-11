"""GCS-backed key/value store for the dev cache (NEO-484). Never raises.

Objects live at `<prefix><kind>/<key>` in the dev cache bucket, where `key` is a
64-character sha256 hex digest built by the kind module (`vision`, `birefnet`).
The bucket deletes objects after 7 days, so nothing here ever deletes.

**Envelope.** Every object is `b"NBC1" + sha256(payload) + payload`. A short
object, a wrong magic or a digest mismatch is CORRUPT: the caller treats it as a
miss, calls the model live, and overwrites the bad object using the generation
it read as the precondition (so a concurrent good write is never clobbered).

**Writes are create-only.** A fresh write carries `if_generation_match=0`, the
same precondition `app.jobs.gcs` uses. A 412 means another request stored the
same key first, which is success: the key fixes the value.

**Bounded.** Reads time out after 2 s and writes after 5 s, with the library's
retries off (`retry=None`). A slow or failing bucket costs at most that, then
the request runs live. A read asks for at most `MAX_OBJECT_BYTES + 1` bytes (one
ranged GET, no extra metadata call), so an object over `MAX_OBJECT_BYTES` is
never held whole in memory and never decoded: it reads as CORRUPT, the request
runs live, and the answer overwrites it.

**Never raises.** Every failure is an outcome or a False, plus a counter bumped
by the kind module, plus a rate-limited warning that names the exception class
only. Keys, object names and payloads are never logged.

The GCS client is built lazily (importing this module needs no credentials,
as in `app.jobs.gcs`) and shared per bucket across threads behind a lock.
"""

from __future__ import annotations

import hashlib
import logging
import re
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Final

from app.timing import increment_current, measure_current

logger = logging.getLogger(__name__)

MAGIC: Final[bytes] = b"NBC1"
DIGEST_LEN: Final[int] = 32
HEADER_LEN: Final[int] = len(MAGIC) + DIGEST_LEN

# The largest object a read will accept. Real payloads (a Vision response proto,
# a padded alpha plane PNG) are a few MB at most; anything larger is not ours.
MAX_OBJECT_BYTES: Final[int] = 64 * 1024 * 1024

READ_TIMEOUT_S: Final[float] = 2.0
WRITE_TIMEOUT_S: Final[float] = 5.0
CONTENT_TYPE: Final[str] = "application/octet-stream"

# At most one warning per (kind, operation) per interval, so a dead bucket
# under the E2E suite logs a line a minute, not a line an image.
WARN_INTERVAL_S: Final[float] = 60.0

HIT: Final[str] = "hit"
MISS: Final[str] = "miss"
CORRUPT: Final[str] = "corrupt"
ERROR: Final[str] = "error"

_KEY_RE = re.compile(r"^[0-9a-f]{64}$")
_KIND_RE = re.compile(r"^[a-z][a-z0-9_]*$")


# ── Envelope ────────────────────────────────────────────────────────────────


def encode(payload: bytes) -> bytes:
    """Wrap `payload` in the `NBC1` envelope."""
    return MAGIC + hashlib.sha256(payload).digest() + payload


def decode(data: bytes) -> bytes | None:
    """The payload of a well-formed envelope, or None for anything else."""
    if len(data) < HEADER_LEN or data[: len(MAGIC)] != MAGIC:
        return None
    digest = data[len(MAGIC) : HEADER_LEN]
    payload = data[HEADER_LEN:]
    if hashlib.sha256(payload).digest() != digest:
        return None
    return payload


# ── Counters and timing (safe: they can never fail a request) ───────────────


def count(name: str) -> None:
    """`increment_current(name)`, swallowing any failure (an unknown field included)."""
    try:
        increment_current(name)
    except Exception:  # noqa: BLE001 - telemetry must never fail the request
        logger.debug("devcache: could not count %s", name, exc_info=True)


@contextmanager
def timed() -> Iterator[None]:
    """`measure_current("cache_ms")` around the body, swallowing timer failures."""
    cm: Any = None
    try:
        cm = measure_current("cache_ms")
        cm.__enter__()
    except Exception:  # noqa: BLE001 - telemetry must never fail the request
        cm = None
    try:
        yield
    finally:
        if cm is not None:
            try:
                cm.__exit__(None, None, None)
            except Exception:  # noqa: BLE001
                pass


_warned_at: dict[tuple[str, str], float] = {}
_warn_lock = threading.Lock()


def warn_limited(kind: str, op: str, exc: BaseException | None = None) -> None:
    """One warning per (kind, op) per `WARN_INTERVAL_S`. Names the exception class only."""
    now = time.monotonic()
    with _warn_lock:
        last = _warned_at.get((kind, op))
        if last is not None and now - last < WARN_INTERVAL_S:
            return
        _warned_at[(kind, op)] = now
    reason = type(exc).__name__ if exc is not None else "invalid"
    logger.warning("devcache: %s %s failed (%s); running live", kind, op, reason)


class ObjectTooLarge(Exception):  # noqa: N818 - names the log line, never raised
    """A cached object over `MAX_OBJECT_BYTES`; only its class name is ever logged."""


class CacheOff(Exception):  # noqa: N818 - a signal, not an error
    """Raised by a kind's key builder when that kind is off for this process.

    For example, B without the baked weights hash. `lookup` answers off with no
    counter and no warning.
    """


# ── Store ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Read:
    """The outcome of one `get`.

    `payload` is set only on HIT. `generation` is the object's generation
    whenever an object was read (HIT or CORRUPT), so a caller that cannot parse
    a HIT's payload can overwrite it with that generation as the precondition.
    """

    outcome: str
    payload: bytes | None = None
    generation: int | None = None


def _is_not_found(exc: BaseException) -> bool:
    from google.api_core import exceptions as gexc

    return isinstance(exc, gexc.NotFound)


def _is_precondition_failed(exc: BaseException) -> bool:
    from google.api_core import exceptions as gexc

    return isinstance(exc, gexc.PreconditionFailed)


class CacheStore:
    """One bucket (and key prefix) of the dev cache.

    `prefix` is "" in the service. The live integration test passes its own
    `itest/<run>/` prefix so it can poison and delete only what it wrote.
    `client` is injectable for tests; otherwise a `storage.Client()` is built on
    first use.
    """

    def __init__(self, bucket: str, *, prefix: str = "", client: Any = None) -> None:
        if not bucket:
            raise ValueError("bucket is required")
        if prefix and not prefix.endswith("/"):
            raise ValueError("prefix must be empty or end with '/'")
        self.bucket_name = bucket
        self.prefix = prefix
        self._client = client
        self._client_lock = threading.Lock()

    def _get_client(self) -> Any:
        if self._client is None:
            with self._client_lock:
                if self._client is None:
                    from google.cloud import storage

                    self._client = storage.Client()
        return self._client

    def object_name(self, kind: str, key: str) -> str:
        if not _KIND_RE.match(kind) or not _KEY_RE.match(key):
            raise ValueError("invalid cache kind or key")
        return f"{self.prefix}{kind}/{key}"

    def _blob(self, kind: str, key: str) -> Any:
        return self._get_client().bucket(self.bucket_name).blob(self.object_name(kind, key))

    def get(self, kind: str, key: str) -> Read:
        """Read and unwrap one object. Never raises."""
        try:
            blob = self._blob(kind, key)
            # `end` is inclusive: one byte past the cap tells an over-cap object
            # from one exactly at it, without a separate metadata request.
            data = blob.download_as_bytes(end=MAX_OBJECT_BYTES, timeout=READ_TIMEOUT_S, retry=None)
        except Exception as exc:  # noqa: BLE001 - every failure is an outcome
            if _is_not_found(exc):
                return Read(MISS)
            warn_limited(kind, "read", exc)
            return Read(ERROR)
        generation = _generation_of(blob)
        if len(data) > MAX_OBJECT_BYTES:
            warn_limited(kind, "size", ObjectTooLarge())
            return Read(CORRUPT, generation=generation)
        payload = decode(bytes(data))
        if payload is None:
            warn_limited(kind, "envelope")
            return Read(CORRUPT, generation=generation)
        return Read(HIT, payload=payload, generation=generation)

    def put(
        self, kind: str, key: str, payload: bytes, *, replace_generation: int | None = None
    ) -> bool:
        """Store `payload` under `key`. True on success, a 412 included. Never raises.

        With `replace_generation` the write replaces exactly that (bad) object
        and nothing newer; without it the write only creates.
        """
        precondition = 0 if replace_generation is None else replace_generation
        try:
            blob = self._blob(kind, key)
            blob.upload_from_string(
                encode(payload),
                content_type=CONTENT_TYPE,
                if_generation_match=precondition,
                timeout=WRITE_TIMEOUT_S,
                retry=None,
            )
        except Exception as exc:  # noqa: BLE001 - every failure is a False
            if _is_precondition_failed(exc):
                return True
            warn_limited(kind, "write", exc)
            return False
        return True


def _generation_of(blob: Any) -> int | None:
    """The generation the download reported, or None when it is unreadable."""
    try:
        gen = getattr(blob, "generation", None)
        return int(gen) if gen is not None else None
    except (TypeError, ValueError):
        return None


_stores: dict[str, CacheStore] = {}
_stores_lock = threading.Lock()


def store_for(bucket: str) -> CacheStore:
    """The process-wide store for `bucket` (one client per bucket per process)."""
    store = _stores.get(bucket)
    if store is None:
        with _stores_lock:
            store = _stores.get(bucket)
            if store is None:
                store = CacheStore(bucket)
                _stores[bucket] = store
    return store


# ── Slot: one lookup's handle for writing the live answer back ──────────────


class Slot:
    """Carries a missed or corrupt lookup's key to the write after the live call.

    Created only when the cache is on and the read did not fail, so a caller
    simply calls `save` (through its kind module) whenever it holds one.
    """

    __slots__ = ("store", "kind", "key", "replace_generation")

    def __init__(
        self, store: CacheStore, kind: str, key: str, replace_generation: int | None
    ) -> None:
        self.store = store
        self.kind = kind
        self.key = key
        self.replace_generation = replace_generation

    def save(self, payload: bytes) -> bool:
        """Write `payload`; counts `cache_write_failures` on failure. Never raises."""
        with timed():
            ok = self.store.put(
                self.kind, self.key, payload, replace_generation=self.replace_generation
            )
        if not ok:
            count("cache_write_failures")
        return ok


# ── The one lookup flow both kinds share ────────────────────────────────────


def lookup[T](
    kind: str, make_key: Callable[[], str], parse: Callable[[bytes], T]
) -> tuple[T | None, Slot | None]:
    """Look `kind` up for this request. Returns `(value, slot)`. Never raises.

    - Cache off (no policy bound, or a gate failed): `(None, None)`; no counter.
    - Hit: `(value, None)`; `<kind>_cache_hits`.
    - Miss: `(None, slot)`; `<kind>_cache_misses`. Save the live answer to `slot`.
    - Corrupt object, or a payload `parse` rejects: `(None, slot)` that
      overwrites the bad generation; `<kind>_cache_errors`.
    - The kind is off for this process (`make_key` raised `CacheOff`):
      `(None, None)`; no counter.
    - The key cannot be built, or the read failed: `(None, None)`;
      `<kind>_cache_errors`. Nothing is written after a failed read, so a slow
      bucket costs one timeout, not two.
    """
    from app.devcache.policy import current

    try:
        policy = current()
        if not policy.enabled or not policy.bucket:
            return None, None
    except Exception:  # noqa: BLE001 - any doubt means live
        return None, None

    try:
        key = make_key()
        cache = store_for(policy.bucket)
    except CacheOff:
        return None, None
    except Exception as exc:  # noqa: BLE001
        warn_limited(kind, "key", exc)
        count(f"{kind}_cache_errors")
        return None, None

    with timed():
        read = cache.get(kind, key)

    if read.outcome == HIT and read.payload is not None:
        try:
            value = parse(read.payload)
        except Exception as exc:  # noqa: BLE001 - an unparseable payload is corrupt
            warn_limited(kind, "parse", exc)
            count(f"{kind}_cache_errors")
            return None, Slot(cache, kind, key, read.generation)
        count(f"{kind}_cache_hits")
        return value, None
    if read.outcome == MISS:
        count(f"{kind}_cache_misses")
        return None, Slot(cache, kind, key, None)
    count(f"{kind}_cache_errors")
    if read.outcome == CORRUPT:
        return None, Slot(cache, kind, key, read.generation)
    return None, None
