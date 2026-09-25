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

import base64
import io
import os

import httpx
import pytest
from PIL import Image, ImageDraw

TARGET_URL_ENV = "SMOKE_TARGET_URL"
INTERNAL_KEY_ENV = "SMOKE_INTERNAL_KEY"
# NEO-170 Phase D: optional IAM identity token, minted by the calling workflow
# with audience = the service's BASE URL (see preprocess-deploy.yml /
# preprocess.yml). Unset for local runs against a public/dev URL — behavior
# there is unchanged. Once set, it goes on EVERY request alongside the
# existing x-internal-key header, including /health: Cloud Run IAM applies
# service-wide, so after the allUsers invoker binding is removed (terraform
# T2) even the health check needs it.
ID_TOKEN_ENV = "SMOKE_ID_TOKEN"
# Startup pre-warms BiRefNet, but tiered still runs real ONNX inference per
# request — 15-60s on 4 vCPU is normal for /process. 240s catches hangs
# while tolerating an honest slow pass (Cloud Run's own cap is 300s).
REQUEST_TIMEOUT = 240.0


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
def auth_headers() -> dict[str, str]:
    """IAM Bearer header, present only when SMOKE_ID_TOKEN is set.

    Merge this into every request's headers (`{**auth_headers, ...}`) — it is
    additive to whatever x-internal-key behavior a given test is exercising,
    never a substitute for it.
    """
    token = os.environ.get(ID_TOKEN_ENV)
    return {"Authorization": f"Bearer {token}"} if token else {}


@pytest.fixture(scope="session")
def client(target_url: str) -> httpx.Client:
    with httpx.Client(base_url=target_url, timeout=REQUEST_TIMEOUT) as c:
        yield c


@pytest.fixture(scope="session")
def synthetic_card_on_desk_image() -> tuple[bytes, tuple[int, int, int, int]]:
    """An unmistakable card on a dark desk, plus the card's true (x, y, w, h).

    For the haiku_bbox smoke: the card fills a well-defined minority of the
    frame against a flat contrasting background so the model has one obvious
    answer. Same bitmap-font, no-asset approach as `synthetic_card_image`.
    """
    frame_w, frame_h = 1200, 1200
    card = (350, 250, 500, 700)
    x, y, w, h = card
    img = Image.new("RGB", (frame_w, frame_h), color=(62, 44, 30))
    draw = ImageDraw.Draw(img)
    draw.rectangle((x, y, x + w - 1, y + h - 1), fill="white", outline="black", width=14)
    draw.rectangle((x + 40, y + 40, x + w - 41, y + 480), fill=(40, 90, 170))
    draw.text((x + 50, y + 510), "SMOKE TEST CARD", fill="black")
    draw.text((x + 50, y + 560), "PLAYER NAME", fill="black")
    draw.text((x + 50, y + 610), "TEAM XYZ  #42", fill="black")
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=90)
    return out.getvalue(), card


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
    def test_health_returns_ok(self, client: httpx.Client, auth_headers: dict[str, str]) -> None:
        response = client.get("/health", headers=auth_headers)
        assert response.status_code == 200, response.text
        assert response.json() == {"status": "ok"}


class TestProcessAuth:
    def test_missing_key_returns_401(
        self, client: httpx.Client, auth_headers: dict[str, str], synthetic_card_image: bytes
    ) -> None:
        response = client.post(
            "/process",
            headers=auth_headers,
            files={"image": ("smoke.jpg", synthetic_card_image, "image/jpeg")},
        )
        assert response.status_code == 401, response.text

    def test_wrong_key_returns_401(
        self, client: httpx.Client, auth_headers: dict[str, str], synthetic_card_image: bytes
    ) -> None:
        response = client.post(
            "/process",
            headers={**auth_headers, "x-internal-key": "definitely-not-the-key"},
            files={"image": ("smoke.jpg", synthetic_card_image, "image/jpeg")},
        )
        assert response.status_code == 401, response.text


class TestProcessHappyPath:
    # Also the live proof that the Anthropic classify call works: every
    # image-only /process path ends in classify_card, and any exception it
    # raises (an SDK that rejects our kwargs included) is a 502, never a 200.
    def test_valid_request_returns_shape(
        self,
        client: httpx.Client,
        internal_key: str,
        auth_headers: dict[str, str],
        synthetic_card_image: bytes,
    ) -> None:
        response = client.post(
            "/process",
            headers={**auth_headers, "x-internal-key": internal_key},
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
        assert isinstance(body["players"], list), f"bad players {body['players']!r}"
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
        # Keep in sync with cropper.STRATEGY_NAMES (not imported here — the
        # smoke job runs without the service's heavyweight deps installed).
        assert body["cropped_source"] in {
            "precropped",
            "tiered",
            "pil_trim_dark",
            "pil_trim_light",
            "sam",
            "haiku_bbox",
            "passthrough",
        }, f"unexpected cropped_source {body['cropped_source']!r}"
        if body["cropped_source"] == "precropped":
            assert body["cropped_image_b64"] is None


class TestHaikuBboxCrop:
    """Live proof that the haiku_bbox strategy's Anthropic call works.

    Nothing else reaches it deterministically: the cascade only runs it after
    tiered and sam fail, and haiku_bbox_crop turns ANY exception (an SDK that
    rejects our kwargs included) into a None, which /crop reports as "ran
    cleanly, no crop". So the assertion is that a crop actually came back.
    """

    def test_haiku_bbox_crops_an_obvious_card(
        self,
        client: httpx.Client,
        internal_key: str,
        auth_headers: dict[str, str],
        synthetic_card_on_desk_image: tuple[bytes, tuple[int, int, int, int]],
    ) -> None:
        image_bytes, (_, _, card_w, card_h) = synthetic_card_on_desk_image
        response = client.post(
            "/crop",
            headers={**auth_headers, "x-internal-key": internal_key},
            files={"image": ("smoke-desk.jpg", image_bytes, "image/jpeg")},
            data={"strategy": "haiku_bbox"},
        )
        assert response.status_code == 200, response.text
        crops = response.json()["crops"]
        assert [c["strategy"] for c in crops] == ["haiku_bbox"], crops
        entry = crops[0]
        assert entry["error"] is None, f"haiku_bbox raised {entry['error']}"
        assert entry["image_b64"], "haiku_bbox returned no crop for an obvious card"

        with Image.open(io.BytesIO(base64.b64decode(entry["image_b64"]))) as cropped:
            out_w, out_h = cropped.size
        # Loose bounds: this proves the call worked and Haiku found the card,
        # not pixel accuracy. A crop of the whole frame would fail them.
        assert 0.6 * card_w <= out_w <= 1.4 * card_w, (out_w, out_h)
        assert 0.6 * card_h <= out_h <= 1.4 * card_h, (out_w, out_h)
