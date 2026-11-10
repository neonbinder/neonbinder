"""Unit tests for app.devcache.store: envelope, GCS calls, failure handling.

Also the home of the in-memory GCS fake and the small helpers the other
`test_devcache_*` files, `test_orient` and `test_cropper_tiered` import. The
fake models generations and both preconditions faithfully, and its methods take
`timeout` and `retry` as required keyword arguments, so the store's bounded,
retry-free calls are part of what every cache test exercises.
"""

from __future__ import annotations

import hashlib
import logging
from contextlib import contextmanager
from typing import Any

import pytest
from google.api_core import exceptions as gexc

from app.devcache import policy, store
from app.timing import Timings, bound

BUCKET = "unit-devcache-bucket"
KEY = "ab" * 32


# ── Fake GCS ────────────────────────────────────────────────────────────────


class FakeCacheBlob:
    def __init__(self, client: FakeCacheClient, bucket: str, name: str) -> None:
        self._client = client
        self.bucket = bucket
        self.name = name
        self.generation: int | None = None

    def download_as_bytes(self, *, timeout: float, retry: Any) -> bytes:
        self._client.calls.append(("read", self.name, {"timeout": timeout, "retry": retry}))
        if self._client.read_error is not None:
            raise self._client.read_error
        objects = self._client.objects(self.bucket)
        if self.name not in objects:
            raise gexc.NotFound("no such object")
        data, generation = objects[self.name]
        self.generation = generation
        return data

    def upload_from_string(
        self,
        data: bytes,
        *,
        content_type: str,
        if_generation_match: int,
        timeout: float,
        retry: Any,
    ) -> None:
        self._client.calls.append(
            (
                "write",
                self.name,
                {
                    "content_type": content_type,
                    "if_generation_match": if_generation_match,
                    "timeout": timeout,
                    "retry": retry,
                },
            )
        )
        if self._client.write_error is not None:
            raise self._client.write_error
        objects = self._client.objects(self.bucket)
        current = objects.get(self.name)
        current_gen = 0 if current is None else current[1]
        if if_generation_match != current_gen:
            raise gexc.PreconditionFailed("generation mismatch")
        self._client.next_generation += 1
        objects[self.name] = (bytes(data), self._client.next_generation)


class FakeCacheBucket:
    def __init__(self, client: FakeCacheClient, name: str) -> None:
        self._client = client
        self.name = name

    def blob(self, name: str) -> FakeCacheBlob:
        return FakeCacheBlob(self._client, self.name, name)


class FakeCacheClient:
    """A whole GCS account in a dict: `{bucket: {name: (data, generation)}}`."""

    def __init__(self) -> None:
        self.buckets: dict[str, dict[str, tuple[bytes, int]]] = {}
        self.calls: list[tuple[str, str, dict[str, Any]]] = []
        self.read_error: BaseException | None = None
        self.write_error: BaseException | None = None
        self.next_generation = 1000

    def bucket(self, name: str) -> FakeCacheBucket:
        return FakeCacheBucket(self, name)

    def objects(self, bucket: str = BUCKET) -> dict[str, tuple[bytes, int]]:
        return self.buckets.setdefault(bucket, {})

    def seed(self, name: str, data: bytes, bucket: str = BUCKET) -> int:
        self.next_generation += 1
        self.objects(bucket)[name] = (data, self.next_generation)
        return self.next_generation

    def ops(self, kind: str) -> list[tuple[str, str, dict[str, Any]]]:
        return [c for c in self.calls if c[0] == kind]


class RefusingClient:
    """A storage client that fails the test on any use."""

    def bucket(self, name: str) -> Any:
        raise AssertionError("the dev cache touched storage while it should be off")


# ── Helpers other test files import ─────────────────────────────────────────


def install_cache(monkeypatch, client: Any = None, prefix: str = "") -> Any:
    """Route the store for `BUCKET` to `client` (a fresh fake by default)."""
    client = FakeCacheClient() if client is None else client
    monkeypatch.setattr(
        store, "_stores", {BUCKET: store.CacheStore(BUCKET, prefix=prefix, client=client)}
    )
    monkeypatch.setattr(store, "_warned_at", {})
    return client


def record_counts(monkeypatch) -> list[str]:
    """Record every counter name the cache bumps (independent of `Timings` fields)."""
    seen: list[str] = []
    monkeypatch.setattr(store, "count", seen.append)
    return seen


ON = policy.CachePolicy(enabled=True, mode=policy.MODE_ON, bucket=BUCKET)


@contextmanager
def cache_on():
    with policy.bound(ON):
        yield


# ── Envelope ────────────────────────────────────────────────────────────────


class TestEnvelope:
    @pytest.mark.parametrize("payload", [b"", b"x", bytes(range(256)) * 40])
    def test_round_trip(self, payload):
        data = store.encode(payload)
        assert data[:4] == b"NBC1"
        assert data[4:36] == hashlib.sha256(payload).digest()
        assert store.decode(data) == payload

    @pytest.mark.parametrize(
        "mangle",
        [
            lambda d: d[:35],  # shorter than the header
            lambda d: b"NBC2" + d[4:],  # wrong magic
            lambda d: d[:4] + bytes(32) + d[36:],  # wrong digest
            lambda d: d + b"!",  # payload grew
            lambda d: d[:-1],  # payload truncated
            lambda d: d[:36] + bytes([d[36] ^ 1]) + d[37:],  # one payload bit flipped
            lambda d: b"",
        ],
    )
    def test_anything_damaged_is_rejected(self, mangle):
        assert store.decode(mangle(store.encode(b"payload"))) is None


# ── Store ───────────────────────────────────────────────────────────────────


class TestCacheStore:
    def test_object_name_carries_prefix_kind_and_key(self):
        s = store.CacheStore(BUCKET, prefix="itest/run1/", client=FakeCacheClient())
        assert s.object_name("vision", KEY) == f"itest/run1/vision/{KEY}"

    @pytest.mark.parametrize("prefix", ["itest", "itest/run1"])
    def test_prefix_must_end_with_a_slash(self, prefix):
        with pytest.raises(ValueError):
            store.CacheStore(BUCKET, prefix=prefix)

    @pytest.mark.parametrize(
        "kind,key", [("vision", "AB" * 32), ("vision", "ab" * 31), ("../x", KEY), ("", KEY)]
    )
    def test_kind_and_key_are_validated(self, kind, key):
        with pytest.raises(ValueError):
            store.CacheStore(BUCKET).object_name(kind, key)

    def test_put_then_get_is_a_hit_with_bounded_retry_free_calls(self):
        client = FakeCacheClient()
        s = store.CacheStore(BUCKET, client=client)

        assert s.put("vision", KEY, b"payload") is True
        read = s.get("vision", KEY)

        assert read.outcome == store.HIT
        assert read.payload == b"payload"
        assert read.generation == client.objects()[f"vision/{KEY}"][1]
        (write,) = client.ops("write")
        assert write[2] == {
            "content_type": "application/octet-stream",
            "if_generation_match": 0,
            "timeout": 5.0,
            "retry": None,
        }
        (rd,) = client.ops("read")
        assert rd[2] == {"timeout": 2.0, "retry": None}

    def test_missing_object_is_a_miss(self):
        assert store.CacheStore(BUCKET, client=FakeCacheClient()).get("vision", KEY) == store.Read(
            store.MISS
        )

    def test_corrupt_object_reports_its_generation(self):
        client = FakeCacheClient()
        gen = client.seed(f"vision/{KEY}", b"garbage")
        read = store.CacheStore(BUCKET, client=client).get("vision", KEY)
        assert read == store.Read(store.CORRUPT, generation=gen)

    @pytest.mark.parametrize(
        "error",
        [
            gexc.GatewayTimeout("slow"),
            gexc.Forbidden("no access"),
            gexc.ServiceUnavailable("down"),
            TimeoutError("read timed out"),
            ConnectionError("reset"),
            RuntimeError("anything"),
        ],
    )
    def test_read_failures_are_errors_and_never_raise(self, error):
        client = FakeCacheClient()
        client.read_error = error
        assert store.CacheStore(BUCKET, client=client).get("vision", KEY).outcome == store.ERROR

    def test_client_construction_failure_is_an_error(self, monkeypatch):
        import google.cloud.storage as gcs

        def _no_credentials():
            raise RuntimeError("no ADC")

        monkeypatch.setattr(gcs, "Client", _no_credentials)
        s = store.CacheStore(BUCKET)
        assert s.get("vision", KEY).outcome == store.ERROR
        assert s.put("vision", KEY, b"p") is False

    def test_client_is_built_lazily_and_once(self, monkeypatch):
        import google.cloud.storage as gcs

        built: list[int] = []

        def _client():
            built.append(1)
            return FakeCacheClient()

        monkeypatch.setattr(gcs, "Client", _client)
        s = store.CacheStore(BUCKET)
        assert built == []
        s.get("vision", KEY)
        s.put("vision", KEY, b"p")
        assert built == [1]

    def test_a_412_on_create_counts_as_success(self):
        client = FakeCacheClient()
        client.seed(f"vision/{KEY}", store.encode(b"first"))
        s = store.CacheStore(BUCKET, client=client)

        assert s.put("vision", KEY, b"second") is True
        # The first writer's value stands.
        assert store.decode(client.objects()[f"vision/{KEY}"][0]) == b"first"

    def test_replace_overwrites_only_the_named_generation(self):
        client = FakeCacheClient()
        bad = client.seed(f"vision/{KEY}", b"garbage")
        s = store.CacheStore(BUCKET, client=client)

        assert s.put("vision", KEY, b"good", replace_generation=bad) is True
        assert client.ops("write")[-1][2]["if_generation_match"] == bad
        assert s.get("vision", KEY).payload == b"good"

    def test_replace_never_clobbers_a_newer_good_object(self):
        client = FakeCacheClient()
        bad = client.seed(f"vision/{KEY}", b"garbage")
        client.seed(f"vision/{KEY}", store.encode(b"someone else's good write"))
        s = store.CacheStore(BUCKET, client=client)

        assert s.put("vision", KEY, b"mine", replace_generation=bad) is True
        assert s.get("vision", KEY).payload == b"someone else's good write"

    @pytest.mark.parametrize(
        "error", [gexc.Forbidden("no"), gexc.GatewayTimeout("slow"), OSError("disk")]
    )
    def test_write_failures_are_false_and_never_raise(self, error):
        client = FakeCacheClient()
        client.write_error = error
        assert store.CacheStore(BUCKET, client=client).put("vision", KEY, b"p") is False

    def test_store_for_shares_one_store_per_bucket(self, monkeypatch):
        monkeypatch.setattr(store, "_stores", {})
        assert store.store_for("a") is store.store_for("a")
        assert store.store_for("a") is not store.store_for("b")


class TestWarnings:
    def test_warnings_are_rate_limited_and_never_carry_the_key(self, monkeypatch, caplog):
        monkeypatch.setattr(store, "_warned_at", {})
        client = FakeCacheClient()
        client.read_error = gexc.Forbidden(f"denied on vision/{KEY}")
        s = store.CacheStore(BUCKET, client=client)

        with caplog.at_level(logging.WARNING, logger="app.devcache.store"):
            for _ in range(5):
                s.get("vision", KEY)

        lines = [r.getMessage() for r in caplog.records]
        assert lines == ["devcache: vision read failed (Forbidden); running live"]
        assert KEY not in caplog.text

    def test_rate_limit_is_per_kind_and_operation(self, monkeypatch, caplog):
        monkeypatch.setattr(store, "_warned_at", {})
        with caplog.at_level(logging.WARNING, logger="app.devcache.store"):
            store.warn_limited("vision", "read")
            store.warn_limited("vision", "write")
            store.warn_limited("birefnet", "read")
            store.warn_limited("vision", "read")
        assert len(caplog.records) == 3


# ── The shared lookup flow ──────────────────────────────────────────────────


def _lookup(parse=lambda b: b.decode()):
    return store.lookup("vision", lambda: KEY, parse)


class TestLookup:
    def test_unbound_is_off_and_touches_nothing(self, monkeypatch):
        install_cache(monkeypatch, RefusingClient())
        seen = record_counts(monkeypatch)
        assert _lookup() == (None, None)
        assert seen == []

    @pytest.mark.parametrize(
        "mode",
        [
            policy.MODE_NOT_DEV,
            policy.MODE_NO_BUCKET,
            policy.MODE_TAGGED_HOST,
            policy.MODE_NO_HOST,
            policy.MODE_ERROR,
        ],
    )
    def test_every_off_policy_touches_nothing(self, monkeypatch, mode):
        install_cache(monkeypatch, RefusingClient())
        seen = record_counts(monkeypatch)
        with policy.bound(policy.CachePolicy(enabled=False, mode=mode, bucket=BUCKET)):
            assert _lookup() == (None, None)
        assert seen == []

    def test_miss_then_save_then_hit(self, monkeypatch):
        client = install_cache(monkeypatch)
        seen = record_counts(monkeypatch)
        with cache_on():
            value, slot = _lookup()
            assert value is None and slot is not None
            assert slot.save(b"answer") is True
            value2, slot2 = _lookup()
        assert (value2, slot2) == ("answer", None)
        assert seen == ["vision_cache_misses", "vision_cache_hits"]
        assert len(client.ops("write")) == 1

    def test_corrupt_object_is_an_error_and_its_slot_overwrites_it(self, monkeypatch):
        client = install_cache(monkeypatch)
        bad = client.seed(f"vision/{KEY}", b"garbage")
        seen = record_counts(monkeypatch)
        with cache_on():
            value, slot = _lookup()
            assert value is None
            assert slot.save(b"good") is True
            assert _lookup() == ("good", None)
        assert client.ops("write")[0][2]["if_generation_match"] == bad
        assert seen == ["vision_cache_errors", "vision_cache_hits"]

    def test_unparseable_payload_is_an_error_and_its_slot_overwrites_it(self, monkeypatch):
        client = install_cache(monkeypatch)
        gen = client.seed(f"vision/{KEY}", store.encode(b"\xff\xfe not utf-8"))
        seen = record_counts(monkeypatch)
        with cache_on():
            value, slot = _lookup()
        assert value is None
        assert slot.replace_generation == gen
        assert seen == ["vision_cache_errors"]

    def test_read_error_writes_nothing_afterwards(self, monkeypatch):
        client = install_cache(monkeypatch)
        client.read_error = gexc.GatewayTimeout("slow")
        seen = record_counts(monkeypatch)
        with cache_on():
            assert _lookup() == (None, None)
        assert seen == ["vision_cache_errors"]
        assert client.ops("write") == []

    def test_key_failure_is_an_error(self, monkeypatch):
        install_cache(monkeypatch, RefusingClient())
        seen = record_counts(monkeypatch)

        def _boom() -> str:
            raise RuntimeError("no version metadata")

        with cache_on():
            assert store.lookup("vision", _boom, bytes.decode) == (None, None)
        assert seen == ["vision_cache_errors"]

    def test_cache_off_signal_is_silent(self, monkeypatch):
        install_cache(monkeypatch, RefusingClient())
        seen = record_counts(monkeypatch)

        def _off() -> str:
            raise store.CacheOff("no weights hash")

        with cache_on():
            assert store.lookup("birefnet", _off, bytes.decode) == (None, None)
        assert seen == []

    def test_failed_save_counts_a_write_failure(self, monkeypatch):
        client = install_cache(monkeypatch)
        seen = record_counts(monkeypatch)
        with cache_on():
            _value, slot = _lookup()
            client.write_error = gexc.Forbidden("no")
            assert slot.save(b"x") is False
        assert seen == ["vision_cache_misses", "cache_write_failures"]

    def test_a_concurrent_412_is_not_a_write_failure(self, monkeypatch):
        client = install_cache(monkeypatch)
        seen = record_counts(monkeypatch)
        with cache_on():
            _value, slot = _lookup()
            client.seed(f"vision/{KEY}", store.encode(b"other request"))
            assert slot.save(b"mine") is True
        assert seen == ["vision_cache_misses"]


class TestTimingsIntegration:
    """The real counters and `cache_ms` on a bound `Timings` (P2's fields)."""

    def test_counters_and_cache_ms_land_on_the_request(self, monkeypatch):
        install_cache(monkeypatch)
        t = Timings()
        with bound(t), cache_on():
            _value, slot = _lookup()
            slot.save(b"answer")
            _lookup()
        assert t.vision_cache_misses == 1
        assert t.vision_cache_hits == 1
        assert t.vision_cache_errors == 0
        assert t.cache_write_failures == 0
        assert t.cache_ms > 0

    def test_unknown_counter_never_fails_the_request(self, monkeypatch):
        install_cache(monkeypatch)
        with bound(Timings()), cache_on():
            store.count("no_such_counter")  # must not raise
            with store.timed():
                pass
