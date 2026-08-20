"""Unit tests for the PREPROCESS_ROLE service split (NEO-175).

The same image runs as two Cloud Run services selected by PREPROCESS_ROLE:
HEAVY (default) loads the local model at startup and runs the full cascade;
FAST runs classical-only and must NEVER load a local model — it skips the
startup warm-up so it cold-starts in seconds. These tests pin the role
resolver's defaulting and the startup hook's role gate.
"""

from __future__ import annotations

import pytest

from app import main
from app.main import ROLE_FAST, ROLE_HEAVY, _preprocess_role, _verify_baked_weights


class TestRoleResolver:
    def test_unset_defaults_to_heavy(self, monkeypatch):
        monkeypatch.delenv("PREPROCESS_ROLE", raising=False)
        assert _preprocess_role() == ROLE_HEAVY

    def test_explicit_fast(self, monkeypatch):
        monkeypatch.setenv("PREPROCESS_ROLE", "fast")
        assert _preprocess_role() == ROLE_FAST

    def test_fast_is_case_and_whitespace_insensitive(self, monkeypatch):
        monkeypatch.setenv("PREPROCESS_ROLE", "  Fast ")
        assert _preprocess_role() == ROLE_FAST

    def test_explicit_heavy(self, monkeypatch):
        monkeypatch.setenv("PREPROCESS_ROLE", "heavy")
        assert _preprocess_role() == ROLE_HEAVY

    def test_unknown_value_falls_back_to_heavy(self, monkeypatch):
        # A misspelled var must never silently downgrade a service that is
        # supposed to run the full cascade into skipping the model.
        monkeypatch.setenv("PREPROCESS_ROLE", "turbo")
        assert _preprocess_role() == ROLE_HEAVY


class TestStartupHookRoleGate:
    """`_verify_baked_weights` is the startup model-load seam.

    Only the HEAVY role loads a model at startup; the FAST role skips both the
    baked-weight check and the ~191s warm-up even when REQUIRE_BAKED_WEIGHTS is
    still set on the shared image.
    """

    def test_fast_role_skips_the_warm_up_even_with_require_baked_weights(self, monkeypatch):
        monkeypatch.setenv("PREPROCESS_ROLE", "fast")
        monkeypatch.setenv("REQUIRE_BAKED_WEIGHTS", "1")
        # No U2NET_HOME weights on disk — HEAVY would raise here; FAST must not
        # even look, and must never warm the model.
        monkeypatch.setenv("U2NET_HOME", "/nonexistent-u2net-home")
        called = {"warm_up": 0}
        monkeypatch.setattr(
            "app.cropper.tiered.warm_up",
            lambda: called.__setitem__("warm_up", called["warm_up"] + 1),
        )

        _verify_baked_weights()  # returns cleanly, no raise

        assert called["warm_up"] == 0

    def test_heavy_role_without_require_baked_weights_is_a_noop(self, monkeypatch):
        # The unit-test default: REQUIRE_BAKED_WEIGHTS unset → the hook returns
        # before any weight check or warm-up (heavy path, unchanged).
        monkeypatch.delenv("PREPROCESS_ROLE", raising=False)
        monkeypatch.delenv("REQUIRE_BAKED_WEIGHTS", raising=False)
        called = {"warm_up": 0}
        monkeypatch.setattr(
            "app.cropper.tiered.warm_up",
            lambda: called.__setitem__("warm_up", called["warm_up"] + 1),
        )

        _verify_baked_weights()

        assert called["warm_up"] == 0

    def test_heavy_role_with_require_baked_weights_but_no_weights_raises(self, monkeypatch):
        # The unchanged HEAVY guard: baked weights required but missing → the
        # startup hook fails loudly rather than letting rembg silently
        # re-download at runtime.
        monkeypatch.delenv("PREPROCESS_ROLE", raising=False)
        monkeypatch.setenv("REQUIRE_BAKED_WEIGHTS", "1")
        monkeypatch.setenv("U2NET_HOME", "/nonexistent-u2net-home")

        with pytest.raises(RuntimeError, match="REQUIRE_BAKED_WEIGHTS"):
            _verify_baked_weights()

    def test_module_exposes_the_role_constants(self):
        # Terraform/Convex references these role names; pin them.
        assert main.ROLE_FAST == "fast"
        assert main.ROLE_HEAVY == "heavy"
        assert main.PREPROCESS_ROLE_ENV == "PREPROCESS_ROLE"
