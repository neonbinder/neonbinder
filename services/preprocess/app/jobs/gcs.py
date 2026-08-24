"""Google Cloud Storage access for placeholder zip jobs.

This is the service's first use of GCS — input has only ever arrived as a
multipart upload — so the whole surface is here, deliberately small: stat,
stream, download, create. Four verbs, no delete, no overwrite, no list.

**Write-once is a property, not an accident.** The preprocess runtime SA holds
`objectViewer` + `objectCreator` on the placeholder bucket and nothing else, so
`storage.objects.delete` is not available to it. Rather than treat that as a
limitation to work around, `create()` leans into it: every write carries
`if_generation_match=0`, which makes GCS itself reject a write to an existing
key with a 412. That turns "we happen not to have delete" into "a write to an
occupied key fails loudly, whatever IAM role we are running as", and it is what
lets the stateless batch routes in `app.main` treat a re-run's writes as
idempotent first-write-wins successes rather than silent overwrites. (Job
state itself lives in Convex — NEO-170 — not under this bucket.)

The client is injectable so tests can drive a fake; in production it defaults
to a lazily-constructed `storage.Client()`, which picks up ADC from the Cloud
Run runtime service account exactly like `app.orient` does for Vision.
Construction is lazy because importing this module must not require credentials
— `/process` and `/crop` do not use GCS and must keep working without them.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import BinaryIO

from google.api_core import exceptions as gcs_exceptions
from google.cloud import storage

logger = logging.getLogger(__name__)

# Chunk size for streamed reads. zipfile seeks to the end of the object for the
# central directory and then jumps between local headers, so a large chunk buys
# nothing but wasted transfer on the seeks; 1 MiB is big enough that a single
# card photo (2-5 MB) costs a handful of range requests rather than hundreds.
STREAM_CHUNK_BYTES = 1024 * 1024


class ObjectStoreError(RuntimeError):
    """Base class for storage failures this module raises deliberately."""


class ObjectAlreadyExistsError(ObjectStoreError):
    """A create() lost the race for a key, or the key was already written."""


class ObjectNotFoundError(ObjectStoreError):
    """The requested object does not exist."""


class ObjectTooLargeError(ObjectStoreError):
    """The object is larger than the caller's declared ceiling."""


@dataclass(frozen=True)
class ObjectRef:
    """A bucket + key pair, and the canonical way to render it for a caller."""

    bucket: str
    name: str

    @property
    def uri(self) -> str:
        return f"gs://{self.bucket}/{self.name}"


@dataclass(frozen=True)
class ObjectStat:
    """The metadata a guard needs before deciding to read an object at all."""

    size: int
    content_type: str | None


class ObjectStore:
    """Thin, intentionally narrow wrapper over the GCS client."""

    def __init__(self, client: storage.Client | None = None) -> None:
        self._client = client

    @property
    def client(self) -> storage.Client:
        # Lazy init is NOT thread-safe. It stays safe only because every
        # request calls stat() on the request thread before any upload-pool
        # thread touches the store — preserve that ordering (or add a lock)
        # if the call sequence is ever reordered.
        if self._client is None:
            self._client = storage.Client()
        return self._client

    def stat(self, ref: ObjectRef) -> ObjectStat | None:
        """Metadata for an object, or None when it does not exist.

        One HTTP round trip, and the only thing standing between a hostile
        object and a read: callers check the size here before opening.
        """
        blob = self.client.bucket(ref.bucket).get_blob(ref.name)
        if blob is None:
            return None
        return ObjectStat(size=int(blob.size or 0), content_type=blob.content_type)

    def open_stream(self, ref: ObjectRef) -> BinaryIO:
        """A seekable read stream over the object.

        Used for the input zip so a 500 MB archive never lands in memory whole:
        `zipfile` seeks around the object and only the entry currently being
        read is decompressed, bounded by the per-entry cap in `app.jobs.zipsafe`.
        """
        blob = self.client.bucket(ref.bucket).get_blob(ref.name)
        if blob is None:
            raise ObjectNotFoundError(f"no such object: {ref.uri}")
        return blob.open("rb", chunk_size=STREAM_CHUNK_BYTES)

    def download(self, ref: ObjectRef, *, max_bytes: int) -> bytes:
        """Read a whole object into memory, refusing anything over `max_bytes`.

        The size is checked from metadata *before* the read rather than by
        truncating afterwards, so an oversized object costs one HEAD rather
        than its own bandwidth.
        """
        blob = self.client.bucket(ref.bucket).get_blob(ref.name)
        if blob is None:
            raise ObjectNotFoundError(f"no such object: {ref.uri}")
        size = int(blob.size or 0)
        if size > max_bytes:
            raise ObjectTooLargeError(
                f"{ref.uri} is {size} bytes, over the {max_bytes} byte ceiling"
            )
        return bytes(blob.download_as_bytes())

    def create(self, ref: ObjectRef, data: bytes, *, content_type: str) -> None:
        """Write an object that must not already exist.

        `if_generation_match=0` is the precondition that makes this a create
        rather than an upsert. GCS answers 412 when the key is occupied, which
        surfaces here as `ObjectAlreadyExistsError`.
        """
        blob = self.client.bucket(ref.bucket).blob(ref.name)
        try:
            blob.upload_from_string(data, content_type=content_type, if_generation_match=0)
        except gcs_exceptions.PreconditionFailed as exc:
            raise ObjectAlreadyExistsError(f"object already exists: {ref.uri}") from exc
