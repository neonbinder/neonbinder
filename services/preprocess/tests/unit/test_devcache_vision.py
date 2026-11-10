"""Unit tests for cache A (app.devcache.vision) and its seat in detect_orientation.

Real `AnnotateImageResponse` messages are used throughout, because the cache
stores their proto wire bytes; storage is the in-memory fake from
`test_devcache_store`.
"""

from __future__ import annotations

import io
from unittest.mock import MagicMock

import pytest
from google.api_core import exceptions as gexc
from google.cloud import vision
from PIL import Image

from app import orient
from app.devcache import policy, store
from app.devcache import vision as dv
from app.orient import OrientationResult, detect_orientation
from tests.unit.test_devcache_store import (
    BUCKET,
    RefusingClient,
    cache_on,
    install_cache,
    record_counts,
)


def _poly(*corners: tuple[int, int]) -> vision.BoundingPoly:
    return vision.BoundingPoly(vertices=[vision.Vertex(x=x, y=y) for x, y in corners])


def _response(n_words: int = 3, rotated: bool = False) -> vision.AnnotateImageResponse:
    """A real response: one full-document box, then `n_words` word boxes.

    Upright words read 0; `rotated` words (top edge pointing down) read 90.
    """
    word = _poly((0, 0), (0, 10), (-5, 10), (-5, 0)) if rotated else _poly((0, 0), (10, 0))
    full = vision.EntityAnnotation(description="doc", bounding_poly=_poly((0, 0), (100, 0)))
    words = [
        vision.EntityAnnotation(description=f"w{i}", bounding_poly=word) for i in range(n_words)
    ]
    return vision.AnnotateImageResponse(text_annotations=[full, *words])


def _error_response() -> vision.AnnotateImageResponse:
    return vision.AnnotateImageResponse(error={"code": 8, "message": "RESOURCE_EXHAUSTED"})


def _client(response) -> MagicMock:
    client = MagicMock()
    client.text_detection.return_value = response
    return client


def _jpeg(color=(200, 30, 30), size=(64, 48)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, color).save(out, format="JPEG")
    return out.getvalue()


IMAGE = _jpeg()


def _object_names(client) -> list[str]:
    return sorted(client.objects(BUCKET))


# ── Key ─────────────────────────────────────────────────────────────────────


class TestKey:
    def test_key_is_a_stable_sha256_hex(self):
        k = dv.cache_key(IMAGE)
        assert k == dv.cache_key(bytes(IMAGE))
        assert len(k) == 64 and int(k, 16) >= 0

    def test_different_bytes_miss(self):
        assert dv.cache_key(IMAGE) != dv.cache_key(IMAGE + b"\x00")
        assert dv.cache_key(IMAGE) != dv.cache_key(_jpeg(color=(10, 30, 30)))

    def test_vision_version_change_misses(self, monkeypatch):
        before = dv.cache_key(IMAGE)
        monkeypatch.setattr(dv, "vision_version", lambda: "999.0.0")
        assert dv.cache_key(IMAGE) != before

    def test_version_is_the_installed_distribution(self):
        from importlib import metadata

        assert dv.vision_version() == metadata.version("google-cloud-vision")

    @pytest.mark.parametrize(
        "name,value",
        [
            ("VISION_CACHE_FORMAT", 2),
            ("FEATURE", "DOCUMENT_TEXT_DETECTION"),
            ("KEY_NAMESPACE", "nb-devcache/other"),
        ],
    )
    def test_every_key_part_changes_the_key(self, monkeypatch, name, value):
        before = dv.cache_key(IMAGE)
        monkeypatch.setattr(dv, name, value)
        assert dv.cache_key(IMAGE) != before

    def test_key_is_built_from_the_bytes_vision_receives(self, monkeypatch):
        """A big photo is shrunk first; the key must name the shrunk bytes."""
        big = _jpeg(size=(800, 600)).ljust(orient.VISION_SHRINK_ABOVE_BYTES + 1, b"\x00")
        keyed: list[bytes] = []
        real_key = dv.cache_key
        monkeypatch.setattr(dv, "cache_key", lambda sent: keyed.append(sent) or real_key(sent))
        install_cache(monkeypatch)
        client = _client(_response())

        with cache_on():
            detect_orientation(big, client=client)

        sent = client.text_detection.call_args.kwargs["image"].content
        assert len(sent) < len(big)
        assert keyed == [sent]


# ── Request shape pin ───────────────────────────────────────────────────────


class TestRequestShapePin:
    """The key names the image bytes and TEXT_DETECTION and nothing else.

    If the request ever gains an option (an `image_context` with language
    hints, a crop hint, a second feature), these fail: bump
    `VISION_CACHE_FORMAT` and put the option into the key before updating them.
    """

    def _assert_bare_request(self, client: MagicMock, sent: bytes) -> None:
        call = client.text_detection.call_args
        assert call.args == ()
        assert set(call.kwargs) == {"image"}
        image = call.kwargs["image"]
        assert isinstance(image, vision.Image)
        fields = [f.name for f, _v in vision.Image.pb(image).ListFields()]
        assert fields == ["content"]
        assert image.content == sent

    def test_injected_client_request_is_image_content_only(self):
        client = _client(_response())
        detect_orientation(IMAGE, client=client)
        self._assert_bare_request(client, IMAGE)

    def test_shared_client_request_is_image_content_only(self, monkeypatch):
        client = _client(_response())
        monkeypatch.setattr(orient, "_client", client)
        detect_orientation(IMAGE)
        self._assert_bare_request(client, IMAGE)


# ── Value ───────────────────────────────────────────────────────────────────


class TestValue:
    def test_serialize_parse_round_trip_is_exact(self):
        r = _response(5, rotated=True)
        back = dv.parse(dv.serialize(r))
        assert back == r
        assert dv.serialize(back) == dv.serialize(r)

    def test_parse_rejects_an_error_answer(self):
        with pytest.raises(ValueError):
            dv.parse(dv.serialize(_error_response()))


# ── detect_orientation with the cache ───────────────────────────────────────


class TestDetectOrientationCached:
    def test_off_by_default_never_touches_storage(self, monkeypatch):
        install_cache(monkeypatch, RefusingClient())
        seen = record_counts(monkeypatch)
        client = _client(_response())
        assert detect_orientation(IMAGE, client=client).text_count == 3
        assert client.text_detection.call_count == 1
        assert seen == []

    @pytest.mark.parametrize("mode", [policy.MODE_TAGGED_HOST, policy.MODE_NOT_DEV])
    def test_an_off_policy_never_touches_storage(self, monkeypatch, mode):
        install_cache(monkeypatch, RefusingClient())
        client = _client(_response())
        with policy.bound(policy.CachePolicy(False, mode)):
            detect_orientation(IMAGE, client=client)
            detect_orientation(IMAGE, client=client)
        assert client.text_detection.call_count == 2

    def test_miss_stores_then_hit_skips_vision_and_answers_the_same(self, monkeypatch):
        fake = install_cache(monkeypatch)
        seen = record_counts(monkeypatch)
        live = _client(_response(4, rotated=True))
        with cache_on():
            first = detect_orientation(IMAGE, client=live)
            refusing = MagicMock()
            refusing.text_detection.side_effect = AssertionError("hit must not call Vision")
            second = detect_orientation(IMAGE, client=refusing)

        assert first == second == OrientationResult(90, 1.0, 4)
        assert live.text_detection.call_count == 1
        assert _object_names(fake) == [f"vision/{dv.cache_key(IMAGE)}"]
        assert seen == ["vision_cache_misses", "vision_cache_hits"]

    def test_hit_skips_the_shared_client_too(self, monkeypatch):
        install_cache(monkeypatch)
        with cache_on():
            detect_orientation(IMAGE, client=_client(_response()))

        def _refuse():
            raise AssertionError("hit must not build a Vision client")

        monkeypatch.setattr(orient, "_client", None)
        monkeypatch.setattr(orient.vision, "ImageAnnotatorClient", _refuse)
        with cache_on():
            assert detect_orientation(IMAGE).text_count == 3

    def test_error_answer_raises_and_is_never_stored(self, monkeypatch):
        fake = install_cache(monkeypatch)
        client = _client(_error_response())
        with cache_on():
            for _ in range(2):
                with pytest.raises(RuntimeError, match="vision api error"):
                    detect_orientation(IMAGE, client=client)
        assert client.text_detection.call_count == 2
        assert fake.ops("write") == []

    @pytest.mark.parametrize(
        "error", [gexc.ServiceUnavailable("x"), gexc.DeadlineExceeded("x"), ValueError("x")]
    )
    def test_exception_propagates_and_is_never_stored(self, monkeypatch, error):
        fake = install_cache(monkeypatch)
        client = MagicMock()
        client.text_detection.side_effect = error
        with cache_on(), pytest.raises(type(error)):
            detect_orientation(IMAGE, client=client)
        assert fake.ops("write") == []

    def test_a_cached_error_answer_is_never_served(self, monkeypatch):
        """Belt and braces: even if one were planted, it reads as corrupt."""
        fake = install_cache(monkeypatch)
        key = dv.cache_key(IMAGE)
        gen = fake.seed(f"vision/{key}", store.encode(dv.serialize(_error_response())))
        seen = record_counts(monkeypatch)
        client = _client(_response())
        with cache_on():
            assert detect_orientation(IMAGE, client=client).text_count == 3
        assert client.text_detection.call_count == 1
        assert fake.ops("write")[0][2]["if_generation_match"] == gen
        assert seen == ["vision_cache_errors"]

    @pytest.mark.parametrize(
        "setup",
        ["read_timeout", "read_forbidden", "write_forbidden", "corrupt", "garbage_proto"],
    )
    def test_every_store_failure_falls_back_to_live(self, monkeypatch, setup):
        fake = install_cache(monkeypatch)
        key = f"vision/{dv.cache_key(IMAGE)}"
        if setup == "read_timeout":
            fake.read_error = gexc.GatewayTimeout("slow")
        elif setup == "read_forbidden":
            fake.read_error = gexc.Forbidden("no")
        elif setup == "write_forbidden":
            fake.write_error = gexc.Forbidden("no")
        elif setup == "corrupt":
            fake.seed(key, b"NBC1 but not really")
        else:
            fake.seed(key, store.encode(b"\xff\xff\xff\xff not a proto"))
        client = _client(_response(2))

        with cache_on():
            result = detect_orientation(IMAGE, client=client)

        assert result == OrientationResult(0, 1.0, 2)
        assert client.text_detection.call_count == 1

    def test_corrupt_entry_is_overwritten_with_the_good_answer(self, monkeypatch):
        fake = install_cache(monkeypatch)
        key = f"vision/{dv.cache_key(IMAGE)}"
        bad = fake.seed(key, b"rubbish")
        with cache_on():
            detect_orientation(IMAGE, client=_client(_response(2)))
        (write,) = fake.ops("write")
        assert write[2]["if_generation_match"] == bad
        assert dv.parse(store.decode(fake.objects()[key][0])) == _response(2)

    def test_a_412_on_write_counts_as_success(self, monkeypatch):
        fake = install_cache(monkeypatch)
        seen = record_counts(monkeypatch)
        key = f"vision/{dv.cache_key(IMAGE)}"
        client = _client(_response())

        def _race(*_a, **_k):
            # Another request stores the same key between our read and write.
            fake.seed(key, store.encode(dv.serialize(_response())))
            return _response()

        client.text_detection.side_effect = _race
        with cache_on():
            detect_orientation(IMAGE, client=client)
        assert seen == ["vision_cache_misses"]
        assert "cache_write_failures" not in seen

    def test_an_unserializable_answer_is_a_write_failure_not_an_error(self, monkeypatch):
        """The legacy SimpleNamespace fakes in test_orient still work with the cache on."""
        from types import SimpleNamespace

        install_cache(monkeypatch)
        seen = record_counts(monkeypatch)
        fake_resp = SimpleNamespace(text_annotations=[], error=SimpleNamespace(message=""))
        with cache_on():
            assert detect_orientation(IMAGE, client=_client(fake_resp)).text_count == 0
        assert seen == ["vision_cache_misses", "cache_write_failures"]
