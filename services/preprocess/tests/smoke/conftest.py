"""Shared fixtures and env contract for the deployed-service smoke tests."""

from __future__ import annotations

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
# request — 15-60s on 4 vCPU is normal for /process. Cloud Run's own request
# cap is 300s. A tagged revision at 0% traffic cold-starts on its first request (BiRefNet
# load, ~3 min measured on heavy), and that first request is the smoke's own, so
# the default leaves room for it. SMOKE_REQUEST_TIMEOUT overrides (seconds).
REQUEST_TIMEOUT = float(os.environ.get("SMOKE_REQUEST_TIMEOUT", "600"))


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


def pytest_configure(config: pytest.Config) -> None:
    # Registered here (not pyproject.toml) so the marker lives beside the only
    # tests that use it; the project runs with --strict-markers.
    config.addinivalue_line(
        "markers",
        "fast_safe: never reaches a local model (BiRefNet/SAM), so it is safe "
        "against the FAST container; the fast-service smokes run -m fast_safe",
    )
