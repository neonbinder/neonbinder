"""Unit tests for app.jobs.gcs — the narrow storage wrapper.

Covers: URI rendering, stat on present/absent objects, streaming reads, the
`max_bytes` ceiling on whole-object downloads, prefix listing, and the property
the rest of the design leans on — `create()` refusing to write over an existing
key because of its `if_generation_match=0` precondition.

Driven against the in-memory fake in `_fake_gcs`, which models the 412 the way
GCS answers it.
"""

from __future__ import annotations

import pytest

from app.jobs.gcs import (
    ObjectAlreadyExistsError,
    ObjectNotFoundError,
    ObjectRef,
    ObjectStore,
    ObjectTooLargeError,
)
from tests.unit._fake_gcs import FakeStorageClient

BUCKET = "neonbinder-placeholder-uploads-test"


@pytest.fixture
def client() -> FakeStorageClient:
    return FakeStorageClient()


@pytest.fixture
def store(client: FakeStorageClient) -> ObjectStore:
    return ObjectStore(client=client)


def ref(name: str) -> ObjectRef:
    return ObjectRef(bucket=BUCKET, name=name)


class TestObjectRef:
    def test_uri_is_the_canonical_rendering(self):
        assert ref("a/b.zip").uri == f"gs://{BUCKET}/a/b.zip"

    def test_is_immutable(self):
        with pytest.raises(AttributeError):
            ref("a").name = "b"  # type: ignore[misc]


class TestStat:
    def test_reports_size_and_content_type(self, client, store):
        client.seed(BUCKET, "a/input.zip", b"1234567890", "application/zip")
        stat = store.stat(ref("a/input.zip"))
        assert stat is not None
        assert stat.size == 10
        assert stat.content_type == "application/zip"

    def test_missing_object_is_none_not_an_error(self, store):
        assert store.stat(ref("nope")) is None


class TestOpenStream:
    def test_streams_the_object(self, client, store):
        client.seed(BUCKET, "a/input.zip", b"payload")
        with store.open_stream(ref("a/input.zip")) as stream:
            assert stream.read() == b"payload"

    def test_missing_object_raises(self, store):
        with pytest.raises(ObjectNotFoundError):
            store.open_stream(ref("nope"))


class TestDownload:
    def test_returns_the_bytes(self, client, store):
        client.seed(BUCKET, "a/x.json", b'{"ok":true}')
        assert store.download(ref("a/x.json"), max_bytes=1024) == b'{"ok":true}'

    def test_refuses_an_object_over_the_ceiling(self, client, store):
        client.seed(BUCKET, "a/big", b"x" * 100)
        with pytest.raises(ObjectTooLargeError):
            store.download(ref("a/big"), max_bytes=99)

    def test_exactly_at_the_ceiling_is_allowed(self, client, store):
        client.seed(BUCKET, "a/edge", b"x" * 100)
        assert len(store.download(ref("a/edge"), max_bytes=100)) == 100

    def test_missing_object_raises(self, store):
        with pytest.raises(ObjectNotFoundError):
            store.download(ref("nope"), max_bytes=10)


class TestCreate:
    def test_writes_a_new_object(self, client, store):
        store.create(ref("a/out.json"), b"{}", content_type="application/json")
        assert client.read(BUCKET, "a/out.json") == b"{}"

    def test_refuses_to_overwrite(self, client, store):
        store.create(ref("a/out.json"), b"{}", content_type="application/json")
        with pytest.raises(ObjectAlreadyExistsError):
            store.create(ref("a/out.json"), b"[]", content_type="application/json")
        # The original survives. Write-once means the first writer wins, and
        # since the runtime SA has no delete, nothing can undo that.
        assert client.read(BUCKET, "a/out.json") == b"{}"


class TestListNames:
    def test_lists_only_the_prefix(self, client, store):
        client.seed(BUCKET, "a/status/00000000.json", b"{}")
        client.seed(BUCKET, "a/status/00000001.json", b"{}")
        client.seed(BUCKET, "b/status/00000000.json", b"{}")
        assert store.list_names(BUCKET, "a/status/") == [
            "a/status/00000000.json",
            "a/status/00000001.json",
        ]

    def test_empty_prefix_lists_nothing(self, store):
        assert store.list_names(BUCKET, "nothing/") == []


class TestLazyClient:
    def test_client_is_not_constructed_until_used(self, monkeypatch):
        # Importing app.main must not require GCS credentials — /process and
        # /crop have never needed them and must keep working without them.
        constructed: list[bool] = []

        def _boom():
            constructed.append(True)
            raise AssertionError("storage.Client() must not be called here")

        monkeypatch.setattr("app.jobs.gcs.storage.Client", _boom)
        ObjectStore()
        assert constructed == []
