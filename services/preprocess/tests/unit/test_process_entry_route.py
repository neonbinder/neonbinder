"""Unit tests for POST /process-entry (NEO-170).

Covers: auth, identifier validation, the unconfigured-bucket 503, the
entry-not-found 404 (terminal), the happy path through the real cascade with
Vision/Anthropic stubbed exactly as test_process_route does, the dHash
contract (16 lowercase hex chars, computed on the extracted ORIGINAL and
never on the crop), rotation being baked into the stored output, the
write-once output semantics (412 → 200 with output_written=false, first
write stands), extension probing for non-JPEG extracted objects, the
502 translation of upstream failures, and the unconditional EXIF upright
for streaming-intake (direct-to-GCS) entries that /extract never touched.

Storage is the shared in-memory fake from `_fake_gcs` driven through the real
`ObjectStore`. No network, no credentials.
"""

from __future__ import annotations

import io
import random
import re

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import cropper
from app.classify import ClassifyResult
from app.dhash import compute_dhash
from app.exif import EXIF_ORIENTATION_TAG, apply_exif_orientation, read_exif_orientation
from app.jobs import zipsafe
from app.jobs.gcs import ObjectStore
from app.main import app
from app.orient import OrientationResult
from tests.unit._fake_gcs import FakeStorageClient

client = TestClient(app)

BUCKET = "test-placeholder-bucket"
USER = "user_2abcDEF123"
JOB = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
EXTRACTED_PREFIX = f"placeholders/{USER}/{JOB}/extracted/"
OUTPUT_PREFIX = f"placeholders/{USER}/{JOB}/output/images/"

DHASH_HEX_RE = re.compile(r"\A[0-9a-f]{16}\Z")


@pytest.fixture(autouse=True)
def _set_internal_key(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_KEY", "test-key")


@pytest.fixture(autouse=True)
def _set_bucket(monkeypatch):
    monkeypatch.setenv("GCS_PLACEHOLDER_BUCKET", BUCKET)


@pytest.fixture(autouse=True)
def _decline_tiered(monkeypatch):
    """Same guard as test_process_route: the tiered strategy's BiRefNet
    fallback would need a real rembg session (model download — forbidden in
    unit tests), so it declines and the rest of the cascade is exercised."""
    monkeypatch.setattr("app.cropper.tiered.tiered_crop", lambda _b: None)


@pytest.fixture()
def fake_gcs(monkeypatch) -> FakeStorageClient:
    fake = FakeStorageClient()
    monkeypatch.setattr("app.main._object_store", ObjectStore(client=fake))
    return fake


def _jpeg(size: tuple[int, int] = (8, 8), color: str = "white") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color=color).save(buf, format="JPEG")
    return buf.getvalue()


def _png(size: tuple[int, int] = (8, 8)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color="white").save(buf, format="PNG")
    return buf.getvalue()


def _oriented_jpeg(orientation: int, size: tuple[int, int] = (40, 20)) -> bytes:
    """A deterministic noise JPEG carrying an explicit EXIF orientation tag.

    Noise (not a flat color) so the dhash actually changes when the pixels are
    transposed — the guard asserts in TestExifUpright depend on that. Small
    enough (< MIN_SIDE_PX per side) that every crop candidate is rejected and
    the cascade deterministically lands on passthrough.
    """
    rng = random.Random(1234)
    raw = bytes(rng.randint(0, 255) for _ in range(size[0] * size[1] * 3))
    img = Image.frombytes("RGB", size, raw)
    out = io.BytesIO()
    exif = img.getexif()
    exif[EXIF_ORIENTATION_TAG] = orientation
    img.save(out, format="JPEG", quality=95, exif=exif)
    return out.getvalue()


def _card_bytes(size: tuple[int, int] = (500, 700)) -> bytes:
    rng = random.Random(size[0] + size[1])
    raw = bytes(rng.randint(0, 255) for _ in range(size[0] * size[1] * 3))
    out = io.BytesIO()
    Image.frombytes("RGB", size, raw).save(out, format="JPEG", quality=85)
    return out.getvalue()


def _stub_orient(monkeypatch, rotation=0, confidence=1.0, text_count=5):
    result = OrientationResult(
        rotation_degrees=rotation,
        confidence=confidence,
        text_count=text_count,
    )
    monkeypatch.setattr(cropper, "detect_orientation", lambda _bytes: result)
    return result


def _stub_classify(monkeypatch, player="Ichiro", team="Mariners", card_number="51", side="front"):
    result = ClassifyResult(
        players=[player] if player else [],
        team=team,
        card_number=card_number,
        side=side,
        raw_text="{}",
    )
    monkeypatch.setattr(cropper, "classify_card", lambda _bytes: result)
    return result


def _post_entry(entry_index: int = 0, user_id: str = USER, job_id: str = JOB, key="test-key"):
    headers = {} if key is None else {"x-internal-key": key}
    return client.post(
        "/process-entry",
        headers=headers,
        json={"job_id": job_id, "user_id": user_id, "entry_index": entry_index},
    )


class TestAuth:
    def test_missing_key_returns_401(self, fake_gcs):
        assert _post_entry(key=None).status_code == 401

    def test_wrong_key_returns_401(self, fake_gcs):
        assert _post_entry(key="wrong").status_code == 401


class TestRequestValidation:
    def test_invalid_user_id_returns_400(self, fake_gcs):
        response = _post_entry(user_id="user_a/../user_b")
        assert response.status_code == 400
        assert response.json()["error_code"] == "INVALID_IDENTIFIER"

    def test_invalid_job_id_returns_400(self, fake_gcs):
        response = _post_entry(job_id="not-a-uuid")
        assert response.status_code == 400
        assert response.json()["error_code"] == "INVALID_IDENTIFIER"

    def test_negative_entry_index_is_a_validation_error(self, fake_gcs):
        # ge=0 on the model: Pydantic refuses it before the handler runs.
        assert _post_entry(entry_index=-1).status_code == 422

    def test_entry_index_over_the_zip_ceiling_is_a_validation_error(self, fake_gcs):
        # le=MAX_ZIP_ENTRIES on the model: /extract can never have produced
        # an ordinal past the archive ceiling, so an absurd index is refused
        # by Pydantic (422) rather than derived into an over-long GCS key
        # that surfaces as a 502.
        assert _post_entry(entry_index=zipsafe.MAX_ZIP_ENTRIES + 1).status_code == 422
        assert _post_entry(entry_index=10**9).status_code == 422

    def test_entry_index_at_the_ceiling_reaches_the_handler(self, fake_gcs):
        # The boundary itself passes validation and gets the handler's own
        # answer (404 — no such extracted object), not a 422.
        assert _post_entry(entry_index=zipsafe.MAX_ZIP_ENTRIES).status_code == 404

    def test_unconfigured_bucket_returns_503_with_retry_after(self, fake_gcs, monkeypatch):
        monkeypatch.delenv("GCS_PLACEHOLDER_BUCKET", raising=False)
        response = _post_entry()
        assert response.status_code == 503
        assert response.json()["error_code"] == "EXTRACT_NOT_CONFIGURED"
        assert "Retry-After" in response.headers

    def test_missing_entry_returns_404(self, fake_gcs):
        response = _post_entry(entry_index=3)
        assert response.status_code == 404
        assert response.json()["error_code"] == "ENTRY_NOT_FOUND"


class TestHappyPath:
    def test_returns_metadata_and_writes_the_output(self, fake_gcs, monkeypatch):
        _stub_orient(monkeypatch, rotation=0, confidence=0.9, text_count=12)
        _stub_classify(monkeypatch, player="Jeter", team="Yankees", card_number="2")
        entry = _jpeg()
        fake_gcs.seed(BUCKET, f"{EXTRACTED_PREFIX}0000.jpg", entry, "image/jpeg")

        response = _post_entry(entry_index=0)

        assert response.status_code == 200, response.text
        body = response.json()
        assert body == {
            "players": ["Jeter"],
            "player": "Jeter",
            "team": "Yankees",
            "card_number": "2",
            "side": "front",
            "rotation_degrees": 0,
            "orient_confidence": 0.9,
            "text_count": 12,
            # The 8x8 fixture is too small to pass the validator, so the
            # cascade falls through to passthrough — same as /process.
            "cropped_source": "passthrough",
            "dhash": f"{compute_dhash(entry):016x}",
            "output_written": True,
        }
        # Rotation 0 → the stored output is the winning bytes unchanged.
        assert fake_gcs.read(BUCKET, f"{OUTPUT_PREFIX}0000.jpg") == entry

    def test_response_never_carries_object_paths(self, fake_gcs, monkeypatch):
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)
        fake_gcs.seed(BUCKET, f"{EXTRACTED_PREFIX}0000.jpg", _jpeg(), "image/jpeg")
        response = _post_entry(entry_index=0)
        assert "placeholders/" not in response.text
        assert BUCKET not in response.text

    def test_dhash_is_16_lowercase_hex_chars(self, fake_gcs, monkeypatch):
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)
        fake_gcs.seed(BUCKET, f"{EXTRACTED_PREFIX}0000.jpg", _card_bytes(), "image/jpeg")
        body = _post_entry(entry_index=0).json()
        assert DHASH_HEX_RE.match(body["dhash"]), body["dhash"]

    def test_dhash_describes_the_original_not_the_crop(self, fake_gcs, monkeypatch):
        # Force a winning crop whose bytes differ from the extracted original;
        # the reported hash must still be the ORIGINAL's (cardlister rule:
        # hash the scan, never the crop).
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)
        good_crop = _card_bytes()
        monkeypatch.setattr("app.cropper.pil_trim.trim_dark", lambda _b: good_crop)
        entry = _jpeg((40, 20))
        fake_gcs.seed(BUCKET, f"{EXTRACTED_PREFIX}0000.jpg", entry, "image/jpeg")

        body = _post_entry(entry_index=0).json()

        assert body["cropped_source"] == "pil_trim_dark"
        assert body["dhash"] == f"{compute_dhash(entry):016x}"
        assert body["dhash"] != f"{compute_dhash(good_crop):016x}"
        # And the object that was stored is the (rotation-0) crop itself.
        assert fake_gcs.read(BUCKET, f"{OUTPUT_PREFIX}0000.jpg") == good_crop

    def test_rotation_is_baked_into_the_stored_output(self, fake_gcs, monkeypatch):
        _stub_orient(monkeypatch, rotation=90)
        _stub_classify(monkeypatch)
        fake_gcs.seed(BUCKET, f"{EXTRACTED_PREFIX}0000.jpg", _jpeg((40, 20)), "image/jpeg")

        response = _post_entry(entry_index=0)

        assert response.status_code == 200, response.text
        assert response.json()["rotation_degrees"] == 90
        stored = fake_gcs.read(BUCKET, f"{OUTPUT_PREFIX}0000.jpg")
        with Image.open(io.BytesIO(stored)) as img:
            assert img.size == (20, 40)  # width/height swapped by the 90° turn

    def test_png_extracted_entry_is_found_by_extension_probe(self, fake_gcs, monkeypatch):
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)
        fake_gcs.seed(BUCKET, f"{EXTRACTED_PREFIX}0007.png", _png(), "image/png")
        response = _post_entry(entry_index=7)
        assert response.status_code == 200, response.text
        assert f"{OUTPUT_PREFIX}0007.png" in fake_gcs.names(BUCKET)


class TestExifUpright:
    """Streaming-intake entries (direct signed-URL uploads to extracted/) skip
    /extract, so they arrive still carrying their EXIF orientation tag.
    /process-entry must upright them itself — unconditionally, and before the
    dhash — so both ingestion paths honour the same contract: the hash
    describes the EXIF-uprighted ORIGINAL, never the stored sideways pixels
    and never the crop."""

    def test_tagged_entry_is_hashed_and_processed_upright(self, fake_gcs, monkeypatch):
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)
        entry = _oriented_jpeg(6)  # orientation 6: viewers rotate 90° CW to display
        upright, orientation = apply_exif_orientation(entry)
        # Fixture sanity: the tag survived the encode, and uprighting the
        # pixels genuinely moves the hash — otherwise this test proves nothing.
        assert orientation == 6
        assert compute_dhash(entry) != compute_dhash(upright)
        fake_gcs.seed(BUCKET, f"{EXTRACTED_PREFIX}0000.jpg", entry, "image/jpeg")

        response = _post_entry(entry_index=0)

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["dhash"] == f"{compute_dhash(upright):016x}"
        assert body["dhash"] != f"{compute_dhash(entry):016x}"
        # The cascade saw the upright pixels too: passthrough + rotation 0
        # stores them as-is, with width/height swapped by the 90° turn and the
        # now-misleading orientation tag stripped (no double rotation later).
        assert body["cropped_source"] == "passthrough"
        stored = fake_gcs.read(BUCKET, f"{OUTPUT_PREFIX}0000.jpg")
        assert stored == upright
        with Image.open(io.BytesIO(stored)) as img:
            assert img.size == (20, 40)
        assert read_exif_orientation(stored) == 1

    def test_as_stored_tag_is_a_byte_identical_no_op(self, fake_gcs, monkeypatch):
        # Orientation 1 ("as stored") must not trigger a decode/re-encode —
        # same guarantee the untagged happy-path tests already pin down: the
        # hash and the stored output are the entry's exact bytes.
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)
        entry = _oriented_jpeg(1)
        fake_gcs.seed(BUCKET, f"{EXTRACTED_PREFIX}0000.jpg", entry, "image/jpeg")

        response = _post_entry(entry_index=0)

        assert response.status_code == 200, response.text
        assert response.json()["dhash"] == f"{compute_dhash(entry):016x}"
        assert fake_gcs.read(BUCKET, f"{OUTPUT_PREFIX}0000.jpg") == entry

    def test_truncated_tagged_entry_returns_502(self, fake_gcs, monkeypatch):
        # Valid JPEG magic and an intact EXIF header carrying a rotating
        # orientation, but the scan data cut off: reading the tag succeeds,
        # the transpose decode fails — the route's undecodable-image 502
        # (same fixture recipe as test_extract_route's undecodable member).
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)
        rng = random.Random(7)
        raw = bytes(rng.randint(0, 255) for _ in range(200 * 200 * 3))
        img = Image.frombytes("RGB", (200, 200), raw)
        out = io.BytesIO()
        exif = img.getexif()
        exif[EXIF_ORIENTATION_TAG] = 6
        img.save(out, format="JPEG", quality=95, exif=exif)
        truncated = out.getvalue()[: int(len(out.getvalue()) * 0.6)]
        fake_gcs.seed(BUCKET, f"{EXTRACTED_PREFIX}0000.jpg", truncated, "image/jpeg")

        assert _post_entry(entry_index=0).status_code == 502


class TestWriteOnceOutput:
    def test_existing_output_reports_output_written_false(self, fake_gcs, monkeypatch):
        # A retried entry: the first attempt's object stands (GCS 412 → not an
        # error), and the response says the write didn't happen this time.
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)
        entry = _jpeg()
        fake_gcs.seed(BUCKET, f"{EXTRACTED_PREFIX}0000.jpg", entry, "image/jpeg")
        fake_gcs.seed(BUCKET, f"{OUTPUT_PREFIX}0000.jpg", b"first-attempt-bytes", "image/jpeg")

        response = _post_entry(entry_index=0)

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["output_written"] is False
        assert body["players"] == ["Ichiro"]  # metadata still comes back
        assert fake_gcs.read(BUCKET, f"{OUTPUT_PREFIX}0000.jpg") == b"first-attempt-bytes"

    def test_retry_after_success_is_first_write_wins(self, fake_gcs, monkeypatch):
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)
        fake_gcs.seed(BUCKET, f"{EXTRACTED_PREFIX}0000.jpg", _jpeg(), "image/jpeg")

        first = _post_entry(entry_index=0)
        second = _post_entry(entry_index=0)

        assert first.json()["output_written"] is True
        assert second.json()["output_written"] is False
        assert fake_gcs.writes.count(f"{OUTPUT_PREFIX}0000.jpg") == 1


class TestUpstreamFailures:
    def test_orient_failure_returns_502(self, fake_gcs, monkeypatch):
        def _boom(_bytes):
            raise RuntimeError("vision api down")

        monkeypatch.setattr(cropper, "detect_orientation", _boom)
        _stub_classify(monkeypatch)
        fake_gcs.seed(BUCKET, f"{EXTRACTED_PREFIX}0000.jpg", _jpeg(), "image/jpeg")
        assert _post_entry(entry_index=0).status_code == 502

    def test_classify_failure_returns_502(self, fake_gcs, monkeypatch):
        _stub_orient(monkeypatch)

        def _boom(_bytes):
            raise RuntimeError("anthropic api down")

        monkeypatch.setattr(cropper, "classify_card", _boom)
        fake_gcs.seed(BUCKET, f"{EXTRACTED_PREFIX}0000.jpg", _jpeg(), "image/jpeg")
        assert _post_entry(entry_index=0).status_code == 502

    def test_undecodable_extracted_object_returns_502(self, fake_gcs, monkeypatch):
        # /extract only writes sniffed images, so bytes that don't decode
        # mean the store was tampered with or corrupted — an upstream 502,
        # not a caller error.
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)
        fake_gcs.seed(BUCKET, f"{EXTRACTED_PREFIX}0000.jpg", b"garbage", "image/jpeg")
        assert _post_entry(entry_index=0).status_code == 502
