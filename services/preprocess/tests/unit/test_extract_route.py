"""Unit tests for POST /extract (NEO-170).

Covers: auth, identifier validation, the missing-input 404, the oversize 413,
archive-level rejection (422 ZIP_REJECTED, terminal), per-entry reject rows
that do NOT fail the archive, EXIF normalisation on the way into storage (a
rotated entry comes out upright, an already-upright entry is stored
byte-identical), zip-order indexing, the no-paths-in-responses rule, and
idempotent re-extraction (the GCS 412 path).

Storage is the shared in-memory fake from `_fake_gcs`, driven through the real
`ObjectStore` so the `if_generation_match=0` write-once behaviour is exercised
for real. No network, no credentials.
"""

from __future__ import annotations

import zipfile
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.exif import EXIF_ORIENTATION_TAG, read_exif_orientation
from app.jobs.gcs import ObjectStore
from app.main import app
from tests.unit._fake_gcs import FakeStorageClient

client = TestClient(app)

BUCKET = "test-placeholder-bucket"
USER = "user_2abcDEF123"
JOB = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
INPUT_KEY = f"placeholders/{USER}/{JOB}/input.zip"
EXTRACTED_PREFIX = f"placeholders/{USER}/{JOB}/extracted/"


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


def _jpeg(size: tuple[int, int] = (60, 40), orientation: int | None = None) -> bytes:
    img = Image.new("RGB", size, (10, 20, 30))
    out = BytesIO()
    if orientation is None:
        img.save(out, format="JPEG", quality=95)
    else:
        exif = img.getexif()
        exif[EXIF_ORIENTATION_TAG] = orientation
        img.save(out, format="JPEG", quality=95, exif=exif)
    return out.getvalue()


def _png(size: tuple[int, int] = (60, 40)) -> bytes:
    out = BytesIO()
    Image.new("RGB", size, (10, 20, 30)).save(out, format="PNG")
    return out.getvalue()


def _zip_bytes(members: list[tuple[str, bytes]]) -> bytes:
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in members:
            archive.writestr(name, data)
    return buf.getvalue()


def _post_extract(user_id: str = USER, job_id: str = JOB, key: str | None = "test-key"):
    headers = {} if key is None else {"x-internal-key": key}
    return client.post("/extract", headers=headers, json={"job_id": job_id, "user_id": user_id})


class TestAuth:
    def test_missing_key_returns_401(self, fake_gcs):
        assert _post_extract(key=None).status_code == 401

    def test_wrong_key_returns_401(self, fake_gcs):
        assert _post_extract(key="wrong").status_code == 401


class TestRequestValidation:
    @pytest.mark.parametrize("user_id", ["", "usr_abc", "user_a/../user_b", "user_a\n"])
    def test_invalid_user_id_returns_400(self, fake_gcs, user_id):
        response = _post_extract(user_id=user_id)
        assert response.status_code == 400
        assert response.json()["error_code"] == "INVALID_IDENTIFIER"

    @pytest.mark.parametrize("job_id", ["", "not-a-uuid", "../../etc/passwd"])
    def test_invalid_job_id_returns_400(self, fake_gcs, job_id):
        response = _post_extract(job_id=job_id)
        assert response.status_code == 400
        assert response.json()["error_code"] == "INVALID_IDENTIFIER"

    def test_unconfigured_bucket_returns_503_with_retry_after(self, fake_gcs, monkeypatch):
        monkeypatch.delenv("GCS_PLACEHOLDER_BUCKET", raising=False)
        response = _post_extract()
        assert response.status_code == 503
        assert response.json()["error_code"] == "EXTRACT_NOT_CONFIGURED"
        assert "Retry-After" in response.headers


class TestInputGuards:
    def test_missing_input_returns_404(self, fake_gcs):
        response = _post_extract()
        assert response.status_code == 404
        assert response.json()["error_code"] == "INPUT_NOT_FOUND"

    def test_oversize_input_returns_413(self, fake_gcs, monkeypatch):
        # The real ceiling is 500MB; lower it so a small object can trip it.
        monkeypatch.setattr("app.jobs.zipsafe.MAX_INPUT_OBJECT_BYTES", 16)
        fake_gcs.seed(BUCKET, INPUT_KEY, _zip_bytes([("card.jpg", _jpeg())]))
        response = _post_extract()
        assert response.status_code == 413
        assert response.json()["error_code"] == "INPUT_TOO_LARGE"

    def test_zip_bomb_returns_422_terminal(self, fake_gcs):
        # 2MB of zeros deflates ~1000:1, far over MAX_COMPRESSION_RATIO.
        fake_gcs.seed(BUCKET, INPUT_KEY, _zip_bytes([("bomb.bin", b"\x00" * (2 * 1024 * 1024))]))
        response = _post_extract()
        assert response.status_code == 422
        body = response.json()
        assert body["error_code"] == "ZIP_REJECTED"
        assert body["reason"] == "compression_ratio_exceeded"
        assert body["retryable"] is False

    def test_not_a_zip_returns_422(self, fake_gcs):
        fake_gcs.seed(BUCKET, INPUT_KEY, b"this is not an archive, sorry")
        response = _post_extract()
        assert response.status_code == 422
        assert response.json()["error_code"] == "ZIP_REJECTED"


class TestExtraction:
    def _seed_mixed_archive(self, fake_gcs) -> None:
        fake_gcs.seed(
            BUCKET,
            INPUT_KEY,
            _zip_bytes(
                [
                    ("card0.jpg", _jpeg()),
                    ("__MACOSX/._card0.jpg", b"applejunk"),  # ignored, consumes no ordinal
                    ("notes.txt", b"not an image at all"),
                    ("card1.png", _png()),
                    (".DS_Store", b"finderjunk"),  # ignored
                ]
            ),
        )

    def test_mixed_archive_reports_rows_in_zip_order(self, fake_gcs):
        self._seed_mixed_archive(fake_gcs)
        response = _post_extract()
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["accepted_count"] == 2
        assert body["rejected_count"] == 1
        assert [entry["index"] for entry in body["entries"]] == [0, 1, 2]
        by_name = {entry["name"]: entry for entry in body["entries"]}
        assert by_name["card0.jpg"]["accepted"] is True
        assert by_name["card0.jpg"]["content_type"] == "image/jpeg"
        assert by_name["card0.jpg"]["size_bytes"] > 0
        assert by_name["card0.jpg"]["reason"] is None
        assert by_name["card1.png"]["content_type"] == "image/png"
        # The .txt is a per-entry reject row — it must NOT fail the archive,
        # and it still consumes its ordinal so zip order is preserved.
        rejected = by_name["notes.txt"]
        assert rejected["accepted"] is False
        assert rejected["reason"] == "unsupported_image_type"
        assert rejected["content_type"] is None
        assert rejected["size_bytes"] is None
        assert rejected["index"] == 1

    def test_accepted_entries_are_written_to_derived_keys(self, fake_gcs):
        self._seed_mixed_archive(fake_gcs)
        _post_extract()
        names = fake_gcs.names(BUCKET)
        assert f"{EXTRACTED_PREFIX}0000.jpg" in names
        assert f"{EXTRACTED_PREFIX}0002.png" in names
        # The rejected ordinal gets no object.
        assert not any(name.startswith(f"{EXTRACTED_PREFIX}0001") for name in names)

    def test_response_never_carries_object_paths(self, fake_gcs):
        # Callers hold {job_id, user_id, index} and nothing else; a key or
        # bucket leaking into the body would invite path-shaped requests.
        self._seed_mixed_archive(fake_gcs)
        response = _post_extract()
        assert "placeholders/" not in response.text
        assert BUCKET not in response.text

    def test_already_upright_entry_is_stored_byte_identical(self, fake_gcs):
        # No EXIF rotation → no re-encode: the stored object is the member's
        # exact bytes, so extraction costs no generation loss.
        original = _jpeg()
        fake_gcs.seed(BUCKET, INPUT_KEY, _zip_bytes([("card.jpg", original)]))
        _post_extract()
        assert fake_gcs.read(BUCKET, f"{EXTRACTED_PREFIX}0000.jpg") == original

    def test_exif_rotated_entry_comes_out_upright(self, fake_gcs):
        # Orientation 6 on a 60x40 landscape: viewers show it as 40x60
        # portrait. The stored pixels must BE 40x60 with the tag gone.
        rotated_member = _zip_bytes([("card.jpg", _jpeg((60, 40), orientation=6))])
        fake_gcs.seed(BUCKET, INPUT_KEY, rotated_member)
        response = _post_extract()
        assert response.status_code == 200, response.text
        stored = fake_gcs.read(BUCKET, f"{EXTRACTED_PREFIX}0000.jpg")
        with Image.open(BytesIO(stored)) as img:
            assert img.size == (40, 60)
        assert read_exif_orientation(stored) == 1

    def test_reextract_is_idempotent_on_the_412_path(self, fake_gcs):
        # A re-run of a timed-out extract derives the same keys; every write
        # answers 412 and is treated as success, not an error.
        original = _jpeg()
        fake_gcs.seed(BUCKET, INPUT_KEY, _zip_bytes([("card.jpg", original)]))
        first = _post_extract()
        second = _post_extract()
        assert first.status_code == 200
        assert second.status_code == 200
        assert second.json() == first.json()
        # Exactly one successful write reached storage for the key.
        assert fake_gcs.writes.count(f"{EXTRACTED_PREFIX}0000.jpg") == 1

    def test_first_write_wins_over_a_partial_rerun(self, fake_gcs):
        # An object already at the derived key (from an earlier attempt) is
        # never overwritten — write-once is the property the design leans on.
        fake_gcs.seed(BUCKET, f"{EXTRACTED_PREFIX}0000.jpg", b"first-attempt-bytes", "image/jpeg")
        fake_gcs.seed(BUCKET, INPUT_KEY, _zip_bytes([("card.jpg", _jpeg())]))
        response = _post_extract()
        assert response.status_code == 200
        assert fake_gcs.read(BUCKET, f"{EXTRACTED_PREFIX}0000.jpg") == b"first-attempt-bytes"

    def test_undecodable_member_is_a_reject_row_not_a_502(self, fake_gcs):
        # Valid JPEG magic bytes and an intact EXIF header carrying a rotating
        # orientation, but the scan data cut off: sniffing accepts it, the
        # transpose decode fails. One bad image must not cost the archive.
        # A noisy image keeps the file big enough that truncating at 60%
        # leaves every header (and the EXIF segment) intact — cut harder and
        # the orientation reads as "as stored", which skips the decode.
        import random

        rng = random.Random(7)
        raw = bytes(rng.randint(0, 255) for _ in range(200 * 200 * 3))
        img = Image.frombytes("RGB", (200, 200), raw)
        out = BytesIO()
        exif = img.getexif()
        exif[EXIF_ORIENTATION_TAG] = 6
        img.save(out, format="JPEG", quality=95, exif=exif)
        whole = out.getvalue()
        truncated = whole[: int(len(whole) * 0.6)]
        fake_gcs.seed(
            BUCKET, INPUT_KEY, _zip_bytes([("bad.jpg", truncated), ("good.jpg", _jpeg())])
        )
        response = _post_extract()
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["accepted_count"] == 1
        assert body["rejected_count"] == 1
        assert body["entries"][0]["reason"] == "entry_undecodable"
        assert body["entries"][1]["accepted"] is True
