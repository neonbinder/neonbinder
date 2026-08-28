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
# NEO-170 Phase D: optional IAM identity token, minted by the calling workflow
# with audience = the service's BASE URL (see preprocess-deploy.yml /
# preprocess.yml). Unset for local runs against a public/dev URL — behavior
# there is unchanged. Once set, it goes on EVERY request alongside the
# existing x-internal-key header, including /health: Cloud Run IAM applies
# service-wide, so after the allUsers invoker binding is removed (terraform
# T2) even the health check needs it.
ID_TOKEN_ENV = "SMOKE_ID_TOKEN"
# tiered runs real ONNX inference per request — 15-60s on 4 vCPU is normal for
# /process — and since NEO-194 the request may ALSO pay the ~160-190s model
# load, because the warm no longer blocks startup.
#
# 240 was safe only because it was standing behind a guard whose job was to
# kill things: a revision that warmed slowly failed Cloud Run's 240s startup
# probe and was destroyed, so this suite never met a genuinely cold instance.
# End-to-end latency did not change with NEO-194 (Cloud Run's request timer
# always included the cold-start wait) — what changed is that a slow warm now
# produces one slow request instead of a dead revision, so the slow request is
# something this suite can finally see.
#
# 280 sits just under Cloud Run's own 300s request cap, which is the real
# ceiling: past that the platform kills the request no matter what we set.
REQUEST_TIMEOUT = 280.0


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


# The warm is request-driven since NEO-194, so drive it before timing anything.
# A cold /process would otherwise pay the model load itself and blow
# REQUEST_TIMEOUT; /warmup gets its own, longer budget because on a genuinely
# cold instance it IS the load.
WARMUP_TIMEOUT = 280.0

# A cold instance can spend longer loading the model than Cloud Run allows for
# a single request (300s), so the FIRST /warmup on a scale-to-zero service can
# be killed mid-load. That is recoverable and does not waste the work: the
# background warm thread lives in the container, so a client disconnect does
# not stop it, and the next call finds the session already resident. Measured
# on the pr-195 preview: attempt 1 died at Cloud Run's cap, the immediate
# retry returned {"status":"warm","was_cold":false} in 0.27s.
WARMUP_ATTEMPTS = 3


@pytest.fixture(scope="session", autouse=True)
def warm_the_service(client: httpx.Client, auth_headers: dict[str, str], internal_key: str):
    """Make the model resident before any test asserts on /process latency.

    NEO-194 moved the BiRefNet warm off the blocking startup path so the
    container can pass Cloud Run's 240s startup probe — it was losing that race
    7 times in prod and 100+ on dev over two weeks. The consequence is that the
    warm is now request-driven: Cloud Run throttles CPU while an instance is
    idle, so the background thread barely progresses until traffic arrives.

    That makes a cold /process pay the full ~160-190s load ON TOP of its own
    work, which is over this suite's REQUEST_TIMEOUT. It is not a regression in
    the service — it is this suite having quietly depended on the blocking
    startup to warm the container for it. `/warmup` (NEO-175) is the actual
    contract for readiness, and Convex already fans it out at session start, so
    calling it here is what a real client does.

    Synchronous and idempotent, so on an already-warm instance this returns
    immediately and costs nothing. A failure here is a genuine smoke failure:
    if the service cannot warm, nothing below is meaningful.

    This is best-effort, NOT a guarantee, and REQUEST_TIMEOUT still has to
    absorb a cold load without it. `/warmup` warms only the instance that
    happens to serve it (NEO-175), and Cloud Run will route a later request to
    a different instance whenever it feels like scaling out — observed here on
    the pr-195 preview, where /warmup and /process landed on two different
    instance ids and the second was cold. Convex handles the real workload by
    fanning out N warmups for N capacity; one call cannot do the same job.
    """
    headers = {**auth_headers, "x-internal-key": internal_key}
    last = "never attempted"
    for attempt in range(1, WARMUP_ATTEMPTS + 1):
        try:
            response = client.post("/warmup", headers=headers, timeout=WARMUP_TIMEOUT)
        except httpx.HTTPError as exc:
            last = f"{type(exc).__name__}: {exc}"
        else:
            if response.status_code == 200 and response.json().get("status") == "warm":
                return
            last = f"HTTP {response.status_code}: {response.text[:200]}"
        print(f"  /warmup attempt {attempt}/{WARMUP_ATTEMPTS} failed ({last}) — retrying")
    raise AssertionError(f"/warmup never reported warm after {WARMUP_ATTEMPTS} attempts: {last}")


class TestProcessHappyPath:
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
