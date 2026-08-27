"""Unit tests for the PREPROCESS_ROLE service split (NEO-175).

The same image runs as two Cloud Run services selected by PREPROCESS_ROLE:
HEAVY (default) loads the local model at startup and runs the full cascade;
FAST runs classical-only and must NEVER load a local model — it skips the
startup warm-up so it cold-starts in seconds. These tests pin the role
resolver's defaulting and the startup hook's role gate.
"""

from __future__ import annotations

import threading
import time

import pytest

from app import main
from app.main import (
    ROLE_FAST,
    ROLE_HEAVY,
    _preprocess_role,
    _verify_baked_weights,
    _warm_birefnet_in_background,
)


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


class TestWarmDoesNotBlockStartup:
    """NEO-194: the HEAVY warm must not hold the port shut.

    FastAPI completes every `startup` handler BEFORE uvicorn accepts
    connections. The warm used to run inline there, so the container did not
    listen on $PORT until BiRefNet was resident — measured at 116-190s against
    Cloud Run's 240s startup-probe ceiling, with the heavy imports still to pay
    first. That lost the race 7 times in prod and 100+ on dev over 14 days, and
    took down the NEO-191 release with a HealthCheckContainerError.

    So the property under test is not "the warm happens" but "the hook RETURNS
    while the warm is still running".
    """

    @pytest.fixture
    def baked_weights(self, tmp_path, monkeypatch):
        """A HEAVY container whose baked weights are present on disk."""
        (tmp_path / "birefnet-general.onnx").write_bytes(b"not-a-real-model")
        monkeypatch.delenv("PREPROCESS_ROLE", raising=False)
        monkeypatch.setenv("REQUIRE_BAKED_WEIGHTS", "1")
        monkeypatch.setenv("U2NET_HOME", str(tmp_path))
        return tmp_path

    def test_the_startup_hook_returns_while_the_warm_is_still_running(
        self, baked_weights, monkeypatch
    ):
        entered = threading.Event()
        release = threading.Event()

        def _slow_warm() -> None:
            entered.set()
            release.wait(timeout=10)

        monkeypatch.setattr("app.cropper.tiered.warm_up", _slow_warm)

        started = time.monotonic()
        _verify_baked_weights()
        elapsed = time.monotonic() - started

        try:
            assert entered.wait(timeout=10), "the background warm never started"
            # The load-bearing assertions: the hook came back, and it came back
            # while the warm was still in flight. Inline, this would have
            # blocked for the full duration.
            assert not release.is_set()
            assert elapsed < 2.0, f"startup hook blocked for {elapsed:.1f}s"
        finally:
            release.set()

    def test_the_warm_still_actually_runs(self, baked_weights, monkeypatch):
        """Off the critical path, not skipped — the model must still load."""
        done = threading.Event()
        monkeypatch.setattr("app.cropper.tiered.warm_up", done.set)

        _verify_baked_weights()

        assert done.wait(timeout=10), "the warm never ran"

    def test_the_warm_thread_is_a_daemon(self, baked_weights, monkeypatch):
        """A warm still in flight must never hold up interpreter exit — Cloud
        Run allows ~10s to drain and an unfinished warm has nothing to save."""
        release = threading.Event()
        monkeypatch.setattr("app.cropper.tiered.warm_up", lambda: release.wait(timeout=10))

        _verify_baked_weights()

        try:
            warm_threads = [t for t in threading.enumerate() if t.name == "birefnet-warm"]
            assert warm_threads, "no thread named birefnet-warm was started"
            assert all(t.daemon for t in warm_threads)
        finally:
            release.set()

    def test_a_failing_warm_is_contained_and_logged(self, monkeypatch, caplog):
        """A failed warm degrades to a slow first request, never a dead process.

        The thread body is called directly here: an exception escaping inside a
        daemon thread would not fail the test that spawned it, so asserting on
        the real thread would pass vacuously.
        """

        def _boom() -> None:
            raise RuntimeError("onnxruntime exploded")

        monkeypatch.setattr("app.cropper.tiered.warm_up", _boom)

        with caplog.at_level("ERROR", logger="app.main"):
            _warm_birefnet_in_background()  # must not raise

        assert "background BiRefNet warm failed" in caplog.text
        assert "onnxruntime exploded" in caplog.text

    def test_a_successful_warm_reports_its_duration(self, monkeypatch, caplog):
        """The timing line is how NEO-194's 116-190s range was measured at all;
        keep it so the margin stays observable after this change."""
        monkeypatch.setattr("app.cropper.tiered.warm_up", lambda: None)

        with caplog.at_level("INFO", logger="app.main"):
            _warm_birefnet_in_background()

        assert "BiRefNet session warmed in" in caplog.text
