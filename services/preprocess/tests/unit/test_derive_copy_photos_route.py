"""Unit tests for POST /derive-copy-photos (NEO-427).

Covers: auth, identifier validation, the unconfigured-bucket 503, the distinct
OUTPUT_NOT_FOUND 404 Convex reads as "the scan is gone", the sizes and their
byte limits, never enlarging, EXIF never surviving, the colour profile
surviving, alpha flattening, extension probing, nothing written, and the
terminal codes for bytes that can never succeed.

Storage is the shared in-memory fake from `_fake_gcs` driven through the real
`ObjectStore`. No network, no credentials.
"""

from __future__ import annotations

import base64
import io
import random

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import copy_photos
from app.imaging import MAX_IMAGE_PIXELS
from app.jobs.gcs import ObjectStore
from app.main import app
from tests.unit._fake_gcs import FakeStorageClient

client = TestClient(app)

BUCKET = "test-placeholder-bucket"
USER = "user_2abcDEF123"
JOB = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
OUTPUT_PREFIX = f"placeholders/{USER}/{JOB}/output/images/"
HEADERS = {"x-internal-key": "test-key"}
BODY = {"job_id": JOB, "user_id": USER, "entry_index": 3}


@pytest.fixture(autouse=True)
def _set_internal_key(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_KEY", "test-key")


@pytest.fixture(autouse=True)
def _set_bucket(monkeypatch):
    monkeypatch.setenv("GCS_PLACEHOLDER_BUCKET", BUCKET)


@pytest.fixture()
def fake_gcs(monkeypatch) -> FakeStorageClient:
    fake = FakeStorageClient()
    monkeypatch.setattr("app.main._object_store", ObjectStore(client=fake))
    return fake


def _encoded(size: tuple[int, int], fmt: str = "JPEG", mode: str = "RGB", **save) -> bytes:
    buf = io.BytesIO()
    color = "navy" if mode == "RGB" else (0, 0, 0, 0)
    Image.new(mode, size, color=color).save(buf, format=fmt, **save)
    return buf.getvalue()


def _noise(size: tuple[int, int]) -> bytes:
    """Hard to compress, so the size limits are really in play."""
    rng = random.Random(427)
    img = Image.frombytes("RGB", size, rng.randbytes(size[0] * size[1] * 3))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _store(fake: FakeStorageClient, name: str, data: bytes, content_type: str) -> None:
    fake.bucket(BUCKET).blob(OUTPUT_PREFIX + name).upload_from_string(
        data, content_type=content_type
    )
    fake.writes.clear()


def _decoded(b64: str) -> Image.Image:
    img = Image.open(io.BytesIO(base64.b64decode(b64)))
    img.load()
    return img


class TestRejections:
    def test_missing_key_is_401(self, fake_gcs):
        assert client.post("/derive-copy-photos", json=BODY).status_code == 401

    def test_bad_identifier_is_a_terminal_400(self, fake_gcs):
        res = client.post(
            "/derive-copy-photos", json={**BODY, "job_id": "../../other"}, headers=HEADERS
        )
        assert res.status_code == 400
        assert res.json()["error_code"] == "INVALID_IDENTIFIER"

    def test_negative_index_is_a_validation_error(self, fake_gcs):
        res = client.post("/derive-copy-photos", json={**BODY, "entry_index": -1}, headers=HEADERS)
        assert res.status_code == 422

    def test_unset_bucket_is_a_retryable_503(self, fake_gcs, monkeypatch):
        monkeypatch.delenv("GCS_PLACEHOLDER_BUCKET")
        res = client.post("/derive-copy-photos", json=BODY, headers=HEADERS)
        assert res.status_code == 503
        assert res.json()["error_code"] == "EXTRACT_NOT_CONFIGURED"

    def test_a_scan_the_bucket_expired_is_its_own_404(self, fake_gcs):
        res = client.post("/derive-copy-photos", json=BODY, headers=HEADERS)
        assert res.status_code == 404
        assert res.json()["error_code"] == "OUTPUT_NOT_FOUND"

    def test_another_entrys_output_does_not_answer(self, fake_gcs):
        _store(fake_gcs, "0004.jpg", _encoded((64, 64)), "image/jpeg")
        res = client.post("/derive-copy-photos", json=BODY, headers=HEADERS)
        assert res.json()["error_code"] == "OUTPUT_NOT_FOUND"

    def test_undecodable_bytes_are_terminal(self, fake_gcs):
        _store(fake_gcs, "0003.jpg", b"not an image at all", "image/jpeg")
        res = client.post("/derive-copy-photos", json=BODY, headers=HEADERS)
        assert res.status_code == 422
        assert res.json()["error_code"] == "OUTPUT_UNDECODABLE"

    def test_a_decompression_bomb_is_terminal(self, fake_gcs):
        side = int(MAX_IMAGE_PIXELS**0.5) + 100
        _store(fake_gcs, "0003.png", _encoded((side, side), fmt="PNG"), "image/png")
        res = client.post("/derive-copy-photos", json=BODY, headers=HEADERS)
        assert res.status_code == 413
        assert res.json()["error_code"] == "OUTPUT_TOO_MANY_PIXELS"

    def test_a_photo_no_quality_can_fit_is_terminal(self, fake_gcs, monkeypatch):
        monkeypatch.setattr(copy_photos, "MAX_COPY_PHOTO_BYTES", 10)
        _store(fake_gcs, "0003.jpg", _encoded((64, 64)), "image/jpeg")
        res = client.post("/derive-copy-photos", json=BODY, headers=HEADERS)
        assert res.status_code == 422
        assert res.json()["error_code"] == "PHOTO_TOO_LARGE"

    def test_a_storage_failure_is_a_retryable_502(self, fake_gcs, monkeypatch):
        def _boom(_ref):
            raise RuntimeError("storage down")

        monkeypatch.setattr("app.main._object_store.stat", _boom)
        res = client.post("/derive-copy-photos", json=BODY, headers=HEADERS)
        assert res.status_code == 502


class TestSizes:
    def test_a_big_scan_comes_back_at_both_long_edges_keeping_its_shape(self, fake_gcs):
        _store(fake_gcs, "0003.jpg", _encoded((2000, 3000)), "image/jpeg")
        res = client.post("/derive-copy-photos", json=BODY, headers=HEADERS)
        assert res.status_code == 200
        body = res.json()
        assert body["content_type"] == "image/jpeg"
        image, thumb = _decoded(body["image"]), _decoded(body["thumb"])
        assert image.format == "JPEG"
        assert thumb.format == "JPEG"
        assert image.size == (1067, 1600)
        assert thumb.size == (240, 360)

    def test_a_landscape_scan_measures_the_long_edge_across(self, fake_gcs):
        _store(fake_gcs, "0003.jpg", _encoded((3000, 2000)), "image/jpeg")
        body = client.post("/derive-copy-photos", json=BODY, headers=HEADERS).json()
        assert _decoded(body["image"]).size == (1600, 1067)

    def test_a_small_scan_is_never_enlarged(self, fake_gcs):
        _store(fake_gcs, "0003.jpg", _encoded((200, 300)), "image/jpeg")
        body = client.post("/derive-copy-photos", json=BODY, headers=HEADERS).json()
        assert _decoded(body["image"]).size == (200, 300)
        assert _decoded(body["thumb"]).size == (200, 300)

    def test_a_noisy_scan_stays_within_both_byte_limits(self, fake_gcs):
        _store(fake_gcs, "0003.png", _noise((1100, 1600)), "image/png")
        body = client.post("/derive-copy-photos", json=BODY, headers=HEADERS).json()
        assert len(base64.b64decode(body["image"])) <= copy_photos.MAX_COPY_PHOTO_BYTES
        assert len(base64.b64decode(body["thumb"])) <= copy_photos.MAX_COPY_THUMB_BYTES

    def test_quality_steps_down_rather_than_failing(self, fake_gcs, monkeypatch):
        scan = _noise((800, 800))
        best = copy_photos.derive_copy_photos(scan)
        monkeypatch.setattr(copy_photos, "MAX_COPY_PHOTO_BYTES", len(best.image) - 1)
        _store(fake_gcs, "0003.png", scan, "image/png")
        body = client.post("/derive-copy-photos", json=BODY, headers=HEADERS).json()
        assert len(base64.b64decode(body["image"])) <= len(best.image) - 1


class TestContents:
    @pytest.mark.parametrize(
        ("name", "fmt", "content_type"),
        [("0003.png", "PNG", "image/png"), ("0003.webp", "WEBP", "image/webp")],
    )
    def test_every_output_extension_is_found(self, fake_gcs, name, fmt, content_type):
        _store(fake_gcs, name, _encoded((64, 64), fmt=fmt), content_type)
        res = client.post("/derive-copy-photos", json=BODY, headers=HEADERS)
        assert res.status_code == 200
        assert _decoded(res.json()["image"]).format == "JPEG"

    def test_exif_never_reaches_the_copy(self, fake_gcs):
        exif = Image.Exif()
        exif[0x010F] = "Some Scanner Maker"
        _store(fake_gcs, "0003.jpg", _encoded((64, 64), exif=exif.tobytes()), "image/jpeg")
        body = client.post("/derive-copy-photos", json=BODY, headers=HEADERS).json()
        for key in ("image", "thumb"):
            assert not _decoded(body[key]).getexif()

    def test_the_colour_profile_stays_with_the_pixels(self, fake_gcs):
        profile = b"not-a-real-profile-but-pillow-only-carries-it"
        _store(fake_gcs, "0003.jpg", _encoded((64, 64), icc_profile=profile), "image/jpeg")
        body = client.post("/derive-copy-photos", json=BODY, headers=HEADERS).json()
        assert _decoded(body["image"]).info.get("icc_profile") == profile

    def test_transparency_lands_on_white(self, fake_gcs):
        _store(fake_gcs, "0003.png", _encoded((64, 64), fmt="PNG", mode="RGBA"), "image/png")
        body = client.post("/derive-copy-photos", json=BODY, headers=HEADERS).json()
        red, green, blue = _decoded(body["image"]).getpixel((32, 32))
        assert min(red, green, blue) > 250

    def test_nothing_is_written(self, fake_gcs):
        _store(fake_gcs, "0003.jpg", _encoded((64, 64)), "image/jpeg")
        assert client.post("/derive-copy-photos", json=BODY, headers=HEADERS).status_code == 200
        assert fake_gcs.writes == []
