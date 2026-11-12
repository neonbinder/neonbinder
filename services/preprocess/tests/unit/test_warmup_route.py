"""Unit tests for POST /warmup (NEO-170, reworked in NEO-484).

/warmup makes the BiRefNet session resident on the instance that handles the
request, so Convex can pre-spin a scale-to-zero container at session start.

Since NEO-484 the session is the direct onnxruntime one in
`app.cropper.birefnet`, and /warmup runs no inference: the model's input is
fixed at 1024x1024, so a "tiny" warm-up pass would cost a full one.

Covers: a cold instance returns {"status": "warm", "was_cold": True} after one
session load; a second call short-circuits on residency (`was_cold=False`, no
reload); an already-resident session never reaches the loader; no inference
runs; the route does no GCS / Vision / Anthropic I/O; auth is required like the
other internal routes; and the FAST role never touches the loader.

No network, no credentials, no model: `_create_session` is stubbed, and the
unit conftest refuses a real ORT session.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app import cropper
from app.cropper import birefnet
from app.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _set_internal_key(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_KEY", "test-key")


@pytest.fixture()
def stub_loader(monkeypatch) -> dict[str, int]:
    """Replace the session factory with a counting stub and forbid inference.

    `birefnet.get_session` caches whatever `_create_session` returns, so the
    real residency check (`is_session_loaded`) and the real `load_session` run
    on top of it; only the ORT construction is faked.
    """
    calls = {"create_session": 0}
    monkeypatch.setattr(birefnet, "_session", None)

    def _fake_create_session():
        calls["create_session"] += 1
        return object()

    def _no_inference(*_args, **_kwargs):
        raise AssertionError("/warmup ran an inference")

    monkeypatch.setattr(birefnet, "_create_session", _fake_create_session)
    monkeypatch.setattr(birefnet, "predict_alpha", _no_inference)
    return calls


def _post_warmup(key="test-key"):
    headers = {} if key is None else {"x-internal-key": key}
    return client.post("/warmup", headers=headers)


class TestAuth:
    def test_missing_key_returns_401(self, stub_loader):
        assert _post_warmup(key=None).status_code == 401

    def test_wrong_key_returns_401(self, stub_loader):
        assert _post_warmup(key="wrong").status_code == 401

    def test_auth_runs_before_any_load(self, stub_loader):
        # A rejected request must never touch the loader.
        _post_warmup(key="wrong")
        assert stub_loader["create_session"] == 0
        assert not birefnet.is_session_loaded()


class TestWarmup:
    def test_returns_warm_and_loads_the_session(self, stub_loader):
        response = _post_warmup()
        assert response.status_code == 200
        # A genuinely cold instance: this call created the session.
        assert response.json() == {"status": "warm", "was_cold": True}
        assert stub_loader["create_session"] == 1
        assert birefnet.is_session_loaded()

    def test_idempotent_second_call_does_not_reload(self, stub_loader):
        first = _post_warmup()
        second = _post_warmup()
        assert first.json() == {"status": "warm", "was_cold": True}
        assert second.json() == {"status": "warm", "was_cold": False}
        assert stub_loader["create_session"] == 1

    def test_already_resident_returns_immediately_without_loading(self, monkeypatch, stub_loader):
        # Simulate a container whose startup hook already loaded the session.
        monkeypatch.setattr(birefnet, "_session", object())
        response = _post_warmup()
        assert response.status_code == 200
        assert response.json() == {"status": "warm", "was_cold": False}
        assert stub_loader["create_session"] == 0

    def test_uses_the_birefnet_loader(self, monkeypatch, stub_loader):
        # The route's load path is `birefnet.load_session`, nothing else.
        loads: list[bool] = []
        real_load = birefnet.load_session

        def _spy():
            loads.append(True)
            return real_load()

        monkeypatch.setattr(birefnet, "load_session", _spy)
        _post_warmup()
        _post_warmup()
        assert loads == [True]

    def test_does_no_gcs_vision_or_anthropic_io(self, monkeypatch, stub_loader):
        # Warm-up is pure model residency: no storage, no Vision orient, no
        # Anthropic classify, and no crop cascade.
        store = MagicMock()
        crop_spy = MagicMock()
        classify_spy = MagicMock()
        orient_spy = MagicMock()
        monkeypatch.setattr("app.main._object_store", store)
        monkeypatch.setattr(cropper, "crop", crop_spy)
        monkeypatch.setattr(cropper, "classify_card", classify_spy)
        monkeypatch.setattr(cropper, "detect_orientation", orient_spy)

        response = _post_warmup()

        assert response.status_code == 200
        assert store.mock_calls == []
        crop_spy.assert_not_called()
        classify_spy.assert_not_called()
        orient_spy.assert_not_called()


class TestFastRoleWarmup:
    """PREPROCESS_ROLE=fast (NEO-175): /warmup must not load a model."""

    def test_fast_role_reports_ready_without_touching_the_loader(self, monkeypatch, stub_loader):
        monkeypatch.setenv("PREPROCESS_ROLE", "fast")
        response = _post_warmup()
        assert response.status_code == 200
        assert response.json() == {"status": "warm", "was_cold": False}
        assert stub_loader["create_session"] == 0
        assert not birefnet.is_session_loaded()

    def test_fast_role_still_requires_auth(self, monkeypatch, stub_loader):
        monkeypatch.setenv("PREPROCESS_ROLE", "fast")
        assert _post_warmup(key="wrong").status_code == 401
