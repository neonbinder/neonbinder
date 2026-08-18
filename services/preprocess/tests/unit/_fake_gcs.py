"""In-memory stand-in for `google.cloud.storage.Client`.

Shared by every test that needs storage: the `/extract` and `/process-entry`
route tests drive the *real* `ObjectStore` against this fake rather than
mocking `ObjectStore` itself, so the wrapper's own behaviour (the
`if_generation_match=0` precondition especially) is exercised everywhere it is
relied on.

Models only what `app.jobs.gcs` touches, and models the one property the
security design leans on faithfully: a write to an occupied key raises
`PreconditionFailed`, exactly as GCS answers 412.
"""

from __future__ import annotations

from io import BytesIO
from typing import BinaryIO

from google.api_core import exceptions as gcs_exceptions


class FakeBlob:
    def __init__(self, bucket: FakeBucket, name: str) -> None:
        self._bucket = bucket
        self.name = name

    @property
    def size(self) -> int | None:
        payload = self._bucket.objects.get(self.name)
        return None if payload is None else len(payload[0])

    @property
    def content_type(self) -> str | None:
        payload = self._bucket.objects.get(self.name)
        return None if payload is None else payload[1]

    def open(self, mode: str = "rb", chunk_size: int | None = None) -> BinaryIO:
        assert mode == "rb"
        return BytesIO(self._bucket.objects[self.name][0])

    def download_as_bytes(self) -> bytes:
        return self._bucket.objects[self.name][0]

    def upload_from_string(
        self,
        data: bytes,
        *,
        content_type: str,
        if_generation_match: int | None = None,
    ) -> None:
        if if_generation_match == 0 and self.name in self._bucket.objects:
            raise gcs_exceptions.PreconditionFailed("object already exists")
        self._bucket.objects[self.name] = (data, content_type)
        self._bucket.client.writes.append(self.name)


class FakeBucket:
    def __init__(self, client: FakeStorageClient, name: str) -> None:
        self.client = client
        self.name = name

    @property
    def objects(self) -> dict[str, tuple[bytes, str]]:
        return self.client.buckets.setdefault(self.name, {})

    def blob(self, name: str) -> FakeBlob:
        return FakeBlob(self, name)

    def get_blob(self, name: str) -> FakeBlob | None:
        return FakeBlob(self, name) if name in self.objects else None


class FakeStorageClient:
    """A whole GCS account's worth of state in a dict of dicts."""

    def __init__(self) -> None:
        self.buckets: dict[str, dict[str, tuple[bytes, str]]] = {}
        self.writes: list[str] = []

    def bucket(self, name: str) -> FakeBucket:
        return FakeBucket(self, name)

    # ── test conveniences ──────────────────────────────────────────────
    def seed(self, bucket: str, name: str, data: bytes, content_type: str = "application/zip"):
        self.buckets.setdefault(bucket, {})[name] = (data, content_type)

    def read(self, bucket: str, name: str) -> bytes:
        return self.buckets[bucket][name][0]

    def names(self, bucket: str) -> list[str]:
        return sorted(self.buckets.get(bucket, {}))
