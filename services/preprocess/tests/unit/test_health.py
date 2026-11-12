"""Unit tests for GET /health.

/health stays unauthenticated (Cloud Run probes) and, since NEO-484, reports
the dev cache mode the request's Host would get. CI reads `dev_cache` after
every deploy: previews and prod must read `off:<reason>`, the dev base `on`.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.devcache import policy
from app.main import app

client = TestClient(app)

BASE_HOST = "neonbinder-preprocess-abc123-uc.a.run.app"
PREVIEW_HOST = "pr-512---neonbinder-preprocess-abc123-uc.a.run.app"
BLUE_GREEN_HOST = "sha-1a2b3c4---neonbinder-preprocess-abc123-uc.a.run.app"


@pytest.fixture
def dev_with_bucket(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "dev")
    monkeypatch.setenv("PREPROCESS_DEV_CACHE_BUCKET", "a-dev-cache-bucket")


def _health(host: str | None = None):
    headers = {} if host is None else {"host": host}
    return client.get("/health", headers=headers)


def test_health_returns_ok(monkeypatch):
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    response = _health()
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "dev_cache": "off:not_dev"}


def test_health_does_not_require_internal_key():
    # /health must stay unauthenticated so Cloud Run health probes pass.
    response = _health()
    assert response.status_code == 200


class TestDevCacheMode:
    def test_dev_base_host_with_bucket_is_on(self, dev_with_bucket):
        assert _health(BASE_HOST).json()["dev_cache"] == "on"

    def test_dev_base_host_with_a_port_is_on(self, dev_with_bucket):
        assert _health(f"{BASE_HOST}:443").json()["dev_cache"] == "on"

    @pytest.mark.parametrize("host", [PREVIEW_HOST, BLUE_GREEN_HOST])
    def test_tagged_hosts_are_off(self, dev_with_bucket, host):
        assert _health(host).json()["dev_cache"] == "off:tagged_host"

    @pytest.mark.parametrize("environment", ["prod", "Dev", "dev ", ""])
    def test_any_environment_but_exactly_dev_is_off(self, monkeypatch, environment):
        monkeypatch.setenv("ENVIRONMENT", environment)
        monkeypatch.setenv("PREPROCESS_DEV_CACHE_BUCKET", "a-dev-cache-bucket")
        assert _health(BASE_HOST).json()["dev_cache"] == "off:not_dev"

    @pytest.mark.parametrize("bucket", [None, "", "   "])
    def test_dev_without_a_bucket_is_off(self, monkeypatch, bucket):
        monkeypatch.setenv("ENVIRONMENT", "dev")
        if bucket is None:
            monkeypatch.delenv("PREPROCESS_DEV_CACHE_BUCKET", raising=False)
        else:
            monkeypatch.setenv("PREPROCESS_DEV_CACHE_BUCKET", bucket)
        assert _health(BASE_HOST).json()["dev_cache"] == "off:no_bucket"

    def test_the_request_host_is_what_is_resolved(self, monkeypatch):
        seen: list[str | None] = []

        def _spy(host):
            seen.append(host)
            return policy.CachePolicy(enabled=False, mode="off:not_dev")

        monkeypatch.setattr(policy, "resolve", _spy)
        _health(PREVIEW_HOST)
        assert seen == [PREVIEW_HOST]

    def test_a_raising_resolver_still_answers_off(self, monkeypatch):
        def _boom(_host):
            raise RuntimeError("policy bug")

        monkeypatch.setattr(policy, "resolve", _boom)
        response = _health(BASE_HOST)
        assert response.status_code == 200
        assert response.json() == {"status": "ok", "dev_cache": "off:error"}

    def test_never_names_the_bucket(self, dev_with_bucket):
        assert "a-dev-cache-bucket" not in _health(BASE_HOST).text
