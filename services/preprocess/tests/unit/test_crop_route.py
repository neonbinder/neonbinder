"""Unit tests for POST /crop.

The /crop endpoint exposes the cascade's individual strategies so a human
can pick an alternative when the cascade's "best" pick looks wrong. It
runs no orient, no classify, and applies no gates — every strategy's raw
output is returned. Crashes from one strategy don't 5xx the whole call;
they're surfaced as a per-entry `error` field.
"""

from __future__ import annotations

import base64
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.cropper import STRATEGY_NAMES
from app.main import MAX_IMAGE_BYTES, app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _set_internal_key(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_KEY", "test-key")


def _jpeg(size: tuple[int, int] = (8, 8), color: str = "white") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color=color).save(buf, format="JPEG")
    return buf.getvalue()


def _stub_all_strategies(monkeypatch, **overrides):
    """Stub each cropper to return the value (or callable) from overrides.

    `overrides` keys match _STRATEGIES attr names: trim_dark, trim_light,
    sam_crop, haiku_bbox_crop. A missing key defaults to None (strategy
    returns None — ran cleanly, no crop). A value can be either bytes
    (returned directly) or a callable (called with image_bytes).
    """
    defaults = {
        "trim_dark": None,
        "trim_light": None,
        "sam_crop": None,
        "haiku_bbox_crop": None,
    }
    defaults.update(overrides)

    def _wrap(value):
        if callable(value):
            return value
        return lambda _b: value

    monkeypatch.setattr("app.cropper.pil_trim.trim_dark", _wrap(defaults["trim_dark"]))
    monkeypatch.setattr("app.cropper.pil_trim.trim_light", _wrap(defaults["trim_light"]))
    monkeypatch.setattr("app.cropper.sam.sam_crop", _wrap(defaults["sam_crop"]))
    monkeypatch.setattr(
        "app.cropper.haiku_bbox.haiku_bbox_crop", _wrap(defaults["haiku_bbox_crop"])
    )


class TestAuth:
    def test_missing_key_returns_401(self):
        response = client.post("/crop", files={"image": ("card.jpg", _jpeg(), "image/jpeg")})
        assert response.status_code == 401

    def test_wrong_key_returns_401(self):
        response = client.post(
            "/crop",
            headers={"x-internal-key": "wrong"},
            files={"image": ("card.jpg", _jpeg(), "image/jpeg")},
        )
        assert response.status_code == 401


class TestRequestValidation:
    def test_unsupported_content_type_returns_415(self, monkeypatch):
        _stub_all_strategies(monkeypatch)
        response = client.post(
            "/crop",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.txt", b"not an image", "text/plain")},
        )
        assert response.status_code == 415

    def test_empty_image_returns_400(self, monkeypatch):
        _stub_all_strategies(monkeypatch)
        response = client.post(
            "/crop",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", b"", "image/jpeg")},
        )
        assert response.status_code == 400

    def test_oversized_image_returns_413(self, monkeypatch):
        _stub_all_strategies(monkeypatch)
        oversized = b"x" * (MAX_IMAGE_BYTES + 1)
        response = client.post(
            "/crop",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", oversized, "image/jpeg")},
        )
        assert response.status_code == 413

    def test_missing_image_field_returns_422_from_fastapi(self):
        # `image` is a required form field on /crop; FastAPI returns 422 if
        # absent. (Auth runs first; bypass it with the correct header.)
        response = client.post("/crop", headers={"x-internal-key": "test-key"})
        assert response.status_code == 422


class TestUnknownStrategy:
    def test_bogus_name_returns_400(self, monkeypatch):
        _stub_all_strategies(monkeypatch)
        response = client.post(
            "/crop",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", _jpeg(), "image/jpeg")},
            data={"strategy": "bogus"},
        )
        assert response.status_code == 400
        body = response.json()
        assert body["error_code"] == "UNKNOWN_STRATEGY"
        assert body["valid"] == list(STRATEGY_NAMES)

    def test_out_of_range_index_returns_400(self, monkeypatch):
        _stub_all_strategies(monkeypatch)
        response = client.post(
            "/crop",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", _jpeg(), "image/jpeg")},
            data={"strategy": "99"},
        )
        assert response.status_code == 400
        assert response.json()["error_code"] == "UNKNOWN_STRATEGY"

    def test_negative_index_returns_400(self, monkeypatch):
        _stub_all_strategies(monkeypatch)
        response = client.post(
            "/crop",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", _jpeg(), "image/jpeg")},
            data={"strategy": "-1"},
        )
        assert response.status_code == 400
        assert response.json()["error_code"] == "UNKNOWN_STRATEGY"


class TestAllStrategies:
    def test_no_strategy_runs_all_in_canonical_order(self, monkeypatch):
        _stub_all_strategies(
            monkeypatch,
            trim_dark=b"dark",
            trim_light=b"light",
            sam_crop=b"sam",
            haiku_bbox_crop=b"haiku",
        )

        response = client.post(
            "/crop",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", _jpeg(), "image/jpeg")},
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert [c["strategy"] for c in body["crops"]] == list(STRATEGY_NAMES)
        assert [c["index"] for c in body["crops"]] == list(range(len(STRATEGY_NAMES)))
        assert [base64.b64decode(c["image_b64"]) for c in body["crops"]] == [
            b"dark",
            b"light",
            b"sam",
            b"haiku",
        ]
        assert all(c["error"] is None for c in body["crops"])

    def test_strategy_returning_none_has_null_b64_and_null_error(self, monkeypatch):
        _stub_all_strategies(
            monkeypatch,
            trim_dark=b"dark",
            trim_light=None,
            sam_crop=b"sam",
            haiku_bbox_crop=None,
        )

        response = client.post(
            "/crop",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", _jpeg(), "image/jpeg")},
        )

        assert response.status_code == 200
        body = response.json()
        by_name = {c["strategy"]: c for c in body["crops"]}
        assert by_name["pil_trim_light"]["image_b64"] is None
        assert by_name["pil_trim_light"]["error"] is None
        assert by_name["haiku_bbox"]["image_b64"] is None
        assert by_name["haiku_bbox"]["error"] is None

    def test_strategy_raising_is_captured_not_propagated(self, monkeypatch):
        def _boom(_b):
            raise ValueError("strategy crashed")

        _stub_all_strategies(
            monkeypatch,
            trim_dark=b"dark",
            sam_crop=_boom,
        )

        response = client.post(
            "/crop",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", _jpeg(), "image/jpeg")},
        )

        # One bad strategy must not 5xx the whole endpoint.
        assert response.status_code == 200, response.text
        body = response.json()
        by_name = {c["strategy"]: c for c in body["crops"]}
        assert by_name["pil_trim_dark"]["error"] is None
        assert base64.b64decode(by_name["pil_trim_dark"]["image_b64"]) == b"dark"
        assert by_name["sam"]["image_b64"] is None
        assert by_name["sam"]["error"] == "ValueError"


class TestSingleStrategy:
    def test_strategy_by_name_runs_only_that_one(self, monkeypatch):
        sam_calls: list[bytes] = []
        haiku_calls: list[bytes] = []

        def _sam(b):
            sam_calls.append(b)
            return b"sam-out"

        def _haiku(b):
            haiku_calls.append(b)
            return b"haiku-out"

        _stub_all_strategies(monkeypatch, sam_crop=_sam, haiku_bbox_crop=_haiku)

        response = client.post(
            "/crop",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", _jpeg(), "image/jpeg")},
            data={"strategy": "sam"},
        )

        assert response.status_code == 200
        body = response.json()
        assert len(body["crops"]) == 1
        assert body["crops"][0]["strategy"] == "sam"
        assert body["crops"][0]["index"] == STRATEGY_NAMES.index("sam")
        assert base64.b64decode(body["crops"][0]["image_b64"]) == b"sam-out"
        assert len(sam_calls) == 1
        # Critically: other strategies must NOT run.
        assert haiku_calls == []

    def test_strategy_by_index_runs_only_that_one(self, monkeypatch):
        _stub_all_strategies(
            monkeypatch,
            trim_dark=b"dark",
            sam_crop=b"sam",
        )

        sam_index = STRATEGY_NAMES.index("sam")
        response = client.post(
            "/crop",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", _jpeg(), "image/jpeg")},
            data={"strategy": str(sam_index)},
        )

        assert response.status_code == 200
        body = response.json()
        assert len(body["crops"]) == 1
        assert body["crops"][0]["strategy"] == "sam"
        assert body["crops"][0]["index"] == sam_index
        assert base64.b64decode(body["crops"][0]["image_b64"]) == b"sam"

    def test_single_strategy_returning_none_returns_one_null_entry(self, monkeypatch):
        _stub_all_strategies(monkeypatch, sam_crop=None)

        response = client.post(
            "/crop",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", _jpeg(), "image/jpeg")},
            data={"strategy": "sam"},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["crops"] == [
            {
                "strategy": "sam",
                "index": STRATEGY_NAMES.index("sam"),
                "image_b64": None,
                "error": None,
            }
        ]


class TestStrategiesSeeUploadedBytes:
    def test_strategies_receive_the_uploaded_image_bytes(self, monkeypatch):
        # Sanity: bytes flow from upload to strategy unmodified.
        seen: dict[str, bytes] = {}

        def _make(name):
            def _fn(b):
                seen[name] = b
                return b"out-" + name.encode()

            return _fn

        _stub_all_strategies(
            monkeypatch,
            trim_dark=_make("trim_dark"),
            trim_light=_make("trim_light"),
            sam_crop=_make("sam_crop"),
            haiku_bbox_crop=_make("haiku_bbox_crop"),
        )

        original = _jpeg((40, 20))
        response = client.post(
            "/crop",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", original, "image/jpeg")},
        )

        assert response.status_code == 200
        # Every strategy got the same original upload bytes.
        assert set(seen.keys()) == {"trim_dark", "trim_light", "sam_crop", "haiku_bbox_crop"}
        for name, data in seen.items():
            assert data == original, f"{name} saw different bytes than uploaded"
