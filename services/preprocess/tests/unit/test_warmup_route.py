"""Unit tests for POST /warmup (NEO-170).

/warmup forces the BiRefNet crop model resident on the instance that handles
the request, so Convex can pre-spin a scale-to-zero container at session-start
and keep the ~930MB load off the first real /process-entry call.

Covers: the happy path returns {"status": "warm", "was_cold": True} on a genuinely
cold instance; the load runs the SAME path a real crop uses (`tiered.warm_up` →
`_get_session` → `rembg.new_session` + one tiny `rembg.remove`); idempotence — a
second call short-circuits on residency with no reload and no inference and reports
`was_cold=False`; an already-resident session returns immediately without touching
the loader at all; the route does NO GCS / Vision / Anthropic I/O; and auth is
required exactly like the other internal routes.

No network, no credentials, no model download — the loader is stubbed and the
conftest guard forbids a real rembg session.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app import cropper
from app.cropper import tiered
from app.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _set_internal_key(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_KEY", "test-key")


@pytest.fixture()
def stub_loader(monkeypatch) -> dict[str, int]:
    """Replace the real model loader + inference with cheap spies.

    Overrides the conftest guard's refusing `rembg.new_session` for this
    test's duration and counts each call, so a test can assert the load path
    ran exactly once across repeat warm-ups (no reload) and the tiny inference
    is skipped once the session is resident.
    """
    calls = {"new_session": 0, "remove": 0}
    session_sentinel = object()

    def _fake_new_session(_model_name, **_kwargs):
        calls["new_session"] += 1
        return session_sentinel

    def _fake_remove(image, **_kwargs):
        calls["remove"] += 1
        return image

    monkeypatch.setattr("rembg.new_session", _fake_new_session)
    monkeypatch.setattr("rembg.remove", _fake_remove)
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
        assert stub_loader["new_session"] == 0
        assert stub_loader["remove"] == 0


class TestWarmup:
    def test_returns_warm_and_loads_the_model(self, stub_loader):
        response = _post_warmup()
        assert response.status_code == 200
        # A genuinely cold instance: this call triggered the load.
        assert response.json() == {"status": "warm", "was_cold": True}
        # The one call that forces the ~930MB session resident ran once, and
        # the tiny in-memory inference (ORT first-run allocations) ran once.
        assert stub_loader["new_session"] == 1
        assert stub_loader["remove"] == 1
        assert tiered.is_session_loaded()

    def test_idempotent_second_call_does_not_reload(self, stub_loader):
        first = _post_warmup()
        second = _post_warmup()
        assert first.status_code == 200
        assert second.status_code == 200
        # First call did the load (was_cold=True); the second found it resident
        # (was_cold=False) so the caller can stay silent.
        assert first.json() == {"status": "warm", "was_cold": True}
        assert second.json() == {"status": "warm", "was_cold": False}
        # Resident after the first call → the second neither reloads the
        # session nor runs another inference.
        assert stub_loader["new_session"] == 1
        assert stub_loader["remove"] == 1

    def test_already_resident_returns_immediately_without_loading(self, monkeypatch, stub_loader):
        # Simulate a container already warmed (by a prior crop or warm-up):
        # the residency check short-circuits before any loader call.
        monkeypatch.setattr(tiered, "_session", object())
        response = _post_warmup()
        assert response.status_code == 200
        assert response.json() == {"status": "warm", "was_cold": False}
        assert stub_loader["new_session"] == 0
        assert stub_loader["remove"] == 0

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
    """PREPROCESS_ROLE=fast (NEO-175): /warmup must not load a model.

    The FAST service has no local model to make resident, so /warmup reports
    ready (was_cold=False) without ever reaching the loader — the same "never
    constructs a model session" invariant the FAST role guarantees everywhere.
    """

    def test_fast_role_reports_ready_without_touching_the_loader(self, monkeypatch, stub_loader):
        monkeypatch.setenv("PREPROCESS_ROLE", "fast")
        response = _post_warmup()
        assert response.status_code == 200
        assert response.json() == {"status": "warm", "was_cold": False}
        # The loader was never touched and no session became resident.
        assert stub_loader["new_session"] == 0
        assert stub_loader["remove"] == 0
        assert not tiered.is_session_loaded()

    def test_fast_role_still_requires_auth(self, monkeypatch, stub_loader):
        monkeypatch.setenv("PREPROCESS_ROLE", "fast")
        assert _post_warmup(key="wrong").status_code == 401
