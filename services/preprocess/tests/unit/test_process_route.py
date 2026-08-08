"""Unit tests for POST /process.

Covers: auth (missing / wrong / correct), request validation (content-type,
empty body, oversized body), upstream failure translation (Vision / Anthropic
exceptions → 502), the happy path end-to-end, and the rotation-before-classify
wiring (rotated bytes are what classify sees).
"""

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import cropper
from app.classify import ClassifyError, ClassifyResult
from app.main import MAX_IMAGE_BYTES, app
from app.orient import OrientationResult

client = TestClient(app)


@pytest.fixture(autouse=True)
def _set_internal_key(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_KEY", "test-key")


def _jpeg(size: tuple[int, int] = (8, 8), color: str = "white") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color=color).save(buf, format="JPEG")
    return buf.getvalue()


def _png(size: tuple[int, int] = (8, 8)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color="white").save(buf, format="PNG")
    return buf.getvalue()


def _stub_orient(monkeypatch, rotation=0, confidence=1.0, text_count=5):
    result = OrientationResult(
        rotation_degrees=rotation,
        confidence=confidence,
        text_count=text_count,
    )
    # Cascade now owns orient; stub its binding rather than main's.
    monkeypatch.setattr(cropper, "detect_orientation", lambda _bytes: result)
    return result


def _stub_classify(
    monkeypatch,
    player="Ichiro",
    team="Mariners",
    card_number="51",
    side="front",
):
    result = ClassifyResult(
        players=[player] if player else [],
        team=team,
        card_number=card_number,
        side=side,
        raw_text="{}",
    )
    calls = []

    def _fake(image_bytes: bytes) -> ClassifyResult:
        calls.append(image_bytes)
        return result

    monkeypatch.setattr(cropper, "classify_card", _fake)
    return calls


class TestAuth:
    def test_missing_key_returns_401(self):
        response = client.post("/process", files={"image": ("card.jpg", _jpeg(), "image/jpeg")})
        assert response.status_code == 401

    def test_wrong_key_returns_401(self):
        response = client.post(
            "/process",
            headers={"x-internal-key": "wrong"},
            files={"image": ("card.jpg", _jpeg(), "image/jpeg")},
        )
        assert response.status_code == 401

    def test_server_without_key_configured_returns_503(self, monkeypatch):
        monkeypatch.delenv("INTERNAL_API_KEY", raising=False)
        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", _jpeg(), "image/jpeg")},
        )
        assert response.status_code == 503


class TestRequestValidation:
    def test_unsupported_content_type_returns_415(self, monkeypatch):
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)
        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.txt", b"not an image", "text/plain")},
        )
        assert response.status_code == 415

    def test_empty_image_returns_400(self, monkeypatch):
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)
        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", b"", "image/jpeg")},
        )
        assert response.status_code == 400

    def test_oversized_image_returns_413(self, monkeypatch):
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)
        # Construct a payload one byte above the max. Content doesn't need to
        # be a valid image — the size check runs before any parsing.
        oversized = b"x" * (MAX_IMAGE_BYTES + 1)
        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", oversized, "image/jpeg")},
        )
        assert response.status_code == 413

    def test_missing_file_field_returns_400_missing_image(self):
        """With image+precropped both optional, an empty request is a
        MISSING_IMAGE 400 rather than a FastAPI-level 422."""
        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
        )
        assert response.status_code == 400
        assert response.json()["error_code"] == "MISSING_IMAGE"


class TestUpstreamFailures:
    def test_orient_failure_returns_502(self, monkeypatch):
        def _boom(_bytes):
            raise RuntimeError("vision api down")

        monkeypatch.setattr(cropper, "detect_orientation", _boom)
        _stub_classify(monkeypatch)

        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", _jpeg(), "image/jpeg")},
        )
        assert response.status_code == 502

    def test_classify_failure_returns_502(self, monkeypatch):
        _stub_orient(monkeypatch)

        def _boom(_bytes):
            raise RuntimeError("anthropic api down")

        monkeypatch.setattr(cropper, "classify_card", _boom)

        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", _jpeg(), "image/jpeg")},
        )
        assert response.status_code == 502

    def test_classify_unparseable_returns_502_with_specific_detail(self, monkeypatch):
        _stub_orient(monkeypatch)

        def _boom(_bytes):
            raise ClassifyError("model babbled")

        monkeypatch.setattr(cropper, "classify_card", _boom)

        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", _jpeg(), "image/jpeg")},
        )
        assert response.status_code == 502
        assert "unparse" in response.json()["detail"].lower()


class TestHappyPath:
    def test_returns_combined_orient_and_classify_fields(self, monkeypatch):
        _stub_orient(monkeypatch, rotation=0, confidence=0.9, text_count=12)
        _stub_classify(monkeypatch, player="Jeter", team="Yankees", card_number="2")

        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", _jpeg(), "image/jpeg")},
        )

        assert response.status_code == 200
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
            # cascade falls through to passthrough. Bytes returned ==
            # bytes uploaded, so no b64 payload.
            "cropped_source": "passthrough",
            "cropped_image_b64": None,
        }

    def test_accepts_png_content_type(self, monkeypatch):
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)

        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.png", _png(), "image/png")},
        )
        assert response.status_code == 200

    def test_rotation_applied_before_classify(self, monkeypatch):
        _stub_orient(monkeypatch, rotation=90)
        classify_inputs = _stub_classify(monkeypatch)

        original_bytes = _jpeg((40, 20))  # wide image, 40x20
        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", original_bytes, "image/jpeg")},
        )

        assert response.status_code == 200
        assert len(classify_inputs) == 1
        # The bytes seen by classify must not be the originals — rotation
        # happened. We don't assert exact pixels (JPEG re-encode differs),
        # but the image dimensions should have flipped.
        with Image.open(io.BytesIO(classify_inputs[0])) as rotated:
            assert rotated.size == (20, 40)

    def test_no_rotation_passthrough(self, monkeypatch):
        _stub_orient(monkeypatch, rotation=0)
        classify_inputs = _stub_classify(monkeypatch)

        original = _jpeg((8, 8))
        client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={"image": ("card.jpg", original, "image/jpeg")},
        )

        assert classify_inputs[0] == original


class TestPrecroppedField:
    """Coverage for the optional `precropped` multipart field added in slice 2a."""

    @staticmethod
    def _card_bytes(size: tuple[int, int] = (500, 700)) -> bytes:
        import random

        rng = random.Random(size[0] + size[1])
        raw = bytes(rng.randint(0, 255) for _ in range(size[0] * size[1] * 3))
        out = io.BytesIO()
        Image.frombytes("RGB", size, raw).save(out, format="JPEG", quality=85)
        return out.getvalue()

    def test_valid_precropped_wins_cascade(self, monkeypatch):
        _stub_orient(monkeypatch)
        classify_inputs = _stub_classify(monkeypatch)

        precropped = self._card_bytes()
        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={
                "image": ("raw.jpg", _jpeg((40, 20)), "image/jpeg"),
                "precropped": ("crop.jpg", precropped, "image/jpeg"),
            },
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["cropped_source"] == "precropped"
        # When source == precropped, client already has the bytes — no b64.
        assert body["cropped_image_b64"] is None
        # Classify should see the precropped bytes (no trimming) before rotation.
        assert len(classify_inputs) == 1

    def test_precropped_wrong_content_type_returns_415(self, monkeypatch):
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)

        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={
                "image": ("raw.jpg", _jpeg(), "image/jpeg"),
                "precropped": ("crop.txt", b"not an image", "text/plain"),
            },
        )
        assert response.status_code == 415
        assert "precropped" in response.json()["detail"]

    def test_empty_precropped_returns_400(self, monkeypatch):
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)

        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={
                "image": ("raw.jpg", _jpeg(), "image/jpeg"),
                "precropped": ("crop.jpg", b"", "image/jpeg"),
            },
        )
        assert response.status_code == 400
        assert "empty precropped" in response.json()["detail"]

    def test_oversized_precropped_returns_413(self, monkeypatch):
        from app.main import MAX_IMAGE_BYTES

        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)

        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={
                "image": ("raw.jpg", _jpeg(), "image/jpeg"),
                "precropped": ("crop.jpg", b"x" * (MAX_IMAGE_BYTES + 1), "image/jpeg"),
            },
        )
        assert response.status_code == 413

    def test_invalid_precropped_falls_through_to_cascade(self, monkeypatch):
        """A tiny precropped fails the validator; cascade runs on image bytes."""
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)

        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={
                "image": ("raw.jpg", _jpeg((40, 20)), "image/jpeg"),
                # 100x100 passes content-type but too-small to be a card.
                "precropped": ("crop.jpg", _jpeg((100, 100)), "image/jpeg"),
            },
        )
        assert response.status_code == 200
        body = response.json()
        # With such a small image and precropped both failing, cascade should
        # reach passthrough (pil_trim on a 40x20 image returns junk and is
        # rejected by validator too).
        assert body["cropped_source"] == "passthrough"
        assert body["cropped_image_b64"] is None

    def test_cascade_produced_bytes_are_returned_as_b64(self, monkeypatch):
        """When source != precropped and cascade produced new bytes, they're b64-encoded."""
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)

        # Force pil_trim to return known good card-shaped bytes. The cascade
        # will pick it and returned_bytes_differ will be True.
        good_crop = self._card_bytes()
        monkeypatch.setattr("app.cropper.pil_trim.trim_dark", lambda _b: good_crop)

        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={
                "image": ("raw.jpg", _jpeg((40, 20)), "image/jpeg"),
                "precropped": ("crop.jpg", _jpeg((100, 100)), "image/jpeg"),
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["cropped_source"] == "pil_trim_dark"
        assert body["cropped_image_b64"] is not None
        import base64

        assert base64.b64decode(body["cropped_image_b64"]) == good_crop


class TestCropOnlyMode:
    """Crop-only mode: caller uploads only `precropped`, no `image`.

    Cuts upload bandwidth (the dominant client-observed cost) by letting
    callers skip the original when their client-side crop is good. On
    validator reject the handler returns 422 with a specific error code
    so the caller can retry with the original attached.
    """

    @staticmethod
    def _card_bytes(size: tuple[int, int] = (500, 700)) -> bytes:
        import random

        rng = random.Random(size[0] + size[1])
        raw = bytes(rng.randint(0, 255) for _ in range(size[0] * size[1] * 3))
        out = io.BytesIO()
        Image.frombytes("RGB", size, raw).save(out, format="JPEG", quality=85)
        return out.getvalue()

    def test_valid_crop_only_returns_200_precropped(self, monkeypatch):
        _stub_orient(monkeypatch, rotation=0, confidence=0.9, text_count=12)
        classify_inputs = _stub_classify(monkeypatch, player="Jeter", team="Yankees")

        crop = self._card_bytes()
        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={"precropped": ("crop.jpg", crop, "image/jpeg")},
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["cropped_source"] == "precropped"
        # Caller already has the bytes — never echo them back in crop-only mode.
        assert body["cropped_image_b64"] is None
        assert body["players"] == ["Jeter"]
        assert body["team"] == "Yankees"
        # Orient ran exactly once (on the crop) — crop-only skips the
        # baseline-orient call the full cascade makes on the original.
        assert len(classify_inputs) == 1

    def test_too_small_crop_returns_422(self, monkeypatch):
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)

        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={
                # 100x140 passes content-type but fails validator min-side=300.
                "precropped": ("crop.jpg", _jpeg((100, 140)), "image/jpeg"),
            },
        )

        assert response.status_code == 422
        body = response.json()
        assert body["error_code"] == "CROP_VALIDATION_FAILED"
        assert body["retry_with_original"] is True
        assert "too small" in body["reason"]

    def test_wrong_aspect_crop_returns_422(self, monkeypatch):
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)

        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={
                # Square 600x600 passes min-size but fails aspect tolerance.
                "precropped": ("crop.jpg", self._card_bytes((600, 600)), "image/jpeg"),
            },
        )

        assert response.status_code == 422
        body = response.json()
        assert body["error_code"] == "CROP_VALIDATION_FAILED"
        assert "aspect" in body["reason"]

    def test_insufficient_text_returns_422(self, monkeypatch):
        # Geometry is fine, but Vision returns text_count=0 → treat as not-a-card.
        _stub_orient(monkeypatch, text_count=0)
        _stub_classify(monkeypatch)

        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={"precropped": ("crop.jpg", self._card_bytes(), "image/jpeg")},
        )

        assert response.status_code == 422
        body = response.json()
        assert body["error_code"] == "CROP_VALIDATION_FAILED"
        assert body["reason"] == "insufficient_text"

    def test_missing_both_fields_returns_400_missing_image(self):
        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            data={"dummy": "ignored"},  # forces a multipart body without files
        )
        assert response.status_code == 400
        body = response.json()
        assert body["error_code"] == "MISSING_IMAGE"

    def test_crop_only_wrong_content_type_returns_415(self, monkeypatch):
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)

        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={"precropped": ("crop.txt", b"not an image", "text/plain")},
        )
        assert response.status_code == 415
        assert "precropped" in response.json()["detail"]

    def test_crop_only_empty_returns_400(self, monkeypatch):
        _stub_orient(monkeypatch)
        _stub_classify(monkeypatch)

        response = client.post(
            "/process",
            headers={"x-internal-key": "test-key"},
            files={"precropped": ("crop.jpg", b"", "image/jpeg")},
        )
        assert response.status_code == 400
        assert "empty precropped" in response.json()["detail"]
