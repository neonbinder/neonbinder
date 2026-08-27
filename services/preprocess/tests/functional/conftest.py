"""Deployed-target config for the crop matrix (NEO-191).

Reuses the `SMOKE_*` env contract rather than inventing a parallel one: both
this suite and `tests/smoke` point at the same deployed service with the same
credentials, and one CI step already knows how to mint them. What differs is
what they assert — smoke checks the envelope is intact, this checks the crop
cascade made the right decision about a real card.

    SMOKE_TARGET_URL    the deployed service (a pr-<N> preview, or dev)
    SMOKE_INTERNAL_KEY  x-internal-key, from Secret Manager
    SMOKE_ID_TOKEN      optional Cloud Run IAM bearer, audience = BASE url

Every fixture is one `/process` round trip, which does run Vision + Anthropic
on the server (~$0.005/image). That is deliberate: `cropped_source` and
`rotation_degrees` are the two things this suite exists to assert and neither
is observable through `/crop`, which skips orient and classify entirely.
"""

from __future__ import annotations

import os

import httpx
import pytest

TARGET_URL_ENV = "SMOKE_TARGET_URL"
INTERNAL_KEY_ENV = "SMOKE_INTERNAL_KEY"
ID_TOKEN_ENV = "SMOKE_ID_TOKEN"

# A cold instance loads ~930MB of BiRefNet before it serves, and a bed scan
# then pays a real ONNX pass on top. Cloud Run's own ceiling is 300s; sit just
# under it so a genuine hang surfaces as a failure rather than a truncation.
REQUEST_TIMEOUT = 290.0

# The service runs container_concurrency=3, so three in flight saturates one
# instance without queueing behind itself. Measured end to end: ~2 min for the
# full matrix against a warm preview.
MAX_CONCURRENCY = 3


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        pytest.skip(f"{name} not set — the crop matrix only runs against a deployed URL")
    return value


@pytest.fixture(scope="session")
def target_url() -> str:
    return _require_env(TARGET_URL_ENV).rstrip("/")


@pytest.fixture(scope="session")
def internal_key() -> str:
    return _require_env(INTERNAL_KEY_ENV)


@pytest.fixture(scope="session")
def auth_headers(internal_key: str) -> dict[str, str]:
    """Every header a request to the deployed service needs.

    The IAM bearer is present only when SMOKE_ID_TOKEN is set — unset for a
    local run against a URL you can already reach. Cloud Run IAM applies
    service-wide, so once the allUsers binding is gone even /health needs it.
    """
    headers = {"x-internal-key": internal_key}
    token = os.environ.get(ID_TOKEN_ENV)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


@pytest.fixture(scope="session")
def client(target_url: str) -> httpx.Client:
    with httpx.Client(base_url=target_url, timeout=REQUEST_TIMEOUT) as c:
        yield c
