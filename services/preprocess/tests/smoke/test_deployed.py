"""Smoke tests for a deployed preprocess service.

Runs against a URL from env (SMOKE_TARGET_URL) with the internal key from env
(SMOKE_INTERNAL_KEY). Used by the CI workflow to gate PR-preview and prod
traffic-shift deploys.

Assertions are shape-only — smoke validates that the service is wired up
correctly (auth works, the pipeline reaches both Vision and Anthropic, the
response envelope is intact). Accuracy is a correctness concern covered by
tests/integration against the committed real-card fixtures.

Invoke:
    SMOKE_TARGET_URL=https://... \\
    SMOKE_INTERNAL_KEY=... \\
    pytest tests/smoke -v
"""

from __future__ import annotations

import io
import os

import httpx
import pytest
from PIL import Image, ImageDraw

TARGET_URL_ENV = "SMOKE_TARGET_URL"
INTERNAL_KEY_ENV = "SMOKE_INTERNAL_KEY"
REQUEST_TIMEOUT = 120.0  # Cold start on preprocess can be slow — SAM weights + torch init.


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        pytest.skip(f"{name} not set — smoke tests only run against a deployed URL")
    return value


@pytest.fixture(scope="session")
def target_url() -> str:
    return _require_env(TARGET_URL_ENV).rstrip("/")


@pytest.fixture(scope="session")
def internal_key() -> str:
    return _require_env(INTERNAL_KEY_ENV)


@pytest.fixture(scope="session")
def client(target_url: str) -> httpx.Client:
    with httpx.Client(base_url=target_url, timeout=REQUEST_TIMEOUT) as c:
        yield c


@pytest.fixture(scope="session")
def synthetic_card_image() -> bytes:
    """Generate a small test image with detectable text.

    Not a real card — just enough for Vision to detect some text and for the
    pipeline to exercise orient→rotate→classify end-to-end. Classify will
    likely return nulls for most fields, which is fine; smoke asserts shape,
    not values.
    """
    img = Image.new("RGB", (600, 900), color="white")
    draw = ImageDraw.Draw(img)
    # Rendering with the default bitmap font keeps the fixture
    # self-contained — no TTF file lookups, no platform-specific fonts.
    draw.text((40, 40), "SMOKE TEST CARD", fill="black")
    draw.text((40, 120), "PLAYER NAME", fill="black")
    draw.text((40, 200), "TEAM XYZ", fill="black")
    draw.text((40, 280), "#42", fill="black")
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=90)
    return out.getvalue()


class TestHealthz:
    def test_health_returns_ok(self, client: httpx.Client) -> None:
        response = client.get("/health")
        assert response.status_code == 200, response.text
        assert response.json() == {"status": "ok"}


class TestProcessAuth:
    def test_missing_key_returns_401(
        self, client: httpx.Client, synthetic_card_image: bytes
    ) -> None:
        response = client.post(
            "/process",
            files={"image": ("smoke.jpg", synthetic_card_image, "image/jpeg")},
        )
        assert response.status_code == 401, response.text

    def test_wrong_key_returns_401(self, client: httpx.Client, synthetic_card_image: bytes) -> None:
        response = client.post(
            "/process",
            headers={"x-internal-key": "definitely-not-the-key"},
            files={"image": ("smoke.jpg", synthetic_card_image, "image/jpeg")},
        )
        assert response.status_code == 401, response.text


class TestProcessHappyPath:
    def test_valid_request_returns_shape(
        self,
        client: httpx.Client,
        internal_key: str,
        synthetic_card_image: bytes,
    ) -> None:
        response = client.post(
            "/process",
            headers={"x-internal-key": internal_key},
            files={"image": ("smoke.jpg", synthetic_card_image, "image/jpeg")},
        )
        assert response.status_code == 200, response.text
        body = response.json()

        expected_keys = {
            "players",
            "player",
            "team",
            "card_number",
            "side",
            "rotation_degrees",
            "orient_confidence",
            "text_count",
            "cropped_source",
            "cropped_image_b64",
        }
        assert set(body.keys()) == expected_keys, f"unexpected keys {sorted(body.keys())}"
        assert body["side"] in {"front", "back"}, f"bad side {body['side']!r}"
        assert body["rotation_degrees"] in {
            0,
            90,
            180,
            270,
        }, f"bad rotation {body['rotation_degrees']!r}"
        assert 0.0 <= body["orient_confidence"] <= 1.0
        assert isinstance(body["text_count"], int) and body["text_count"] >= 0
        # Synthetic test image is card-shaped (600x900) and noisy → passes the
        # precropped validator. cropped_image_b64 should be null in that case.
        assert body["cropped_source"] in {
            "precropped",
            "pil_trim_dark",
            "pil_trim_light",
            "passthrough",
        }, f"unexpected cropped_source {body['cropped_source']!r}"
        if body["cropped_source"] == "precropped":
            assert body["cropped_image_b64"] is None
