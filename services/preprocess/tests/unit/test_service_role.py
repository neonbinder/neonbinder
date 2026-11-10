"""Unit tests for the PREPROCESS_ROLE service split (NEO-175).

The same image runs as two Cloud Run services selected by PREPROCESS_ROLE:
HEAVY (default) loads the local model at startup and runs the full cascade;
FAST runs classical-only and must NEVER load a local model — it skips the
startup session load so it cold-starts in seconds. These tests pin the role
resolver's defaulting, the startup hook's role gate, and (NEO-484) the one
`cold_start` line the hook writes on every boot.
"""

from __future__ import annotations

import json
import logging

import pytest

from app import main, timing
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


@pytest.fixture
def load_calls(monkeypatch) -> list[bool]:
    """Count `birefnet.load_session` calls; the stub reports a fixed load time."""
    calls: list[bool] = []

    def _fake_load():
        calls.append(True)
        return {"session_load_s": 3.25, "model": "birefnet-general", "ort": "1.2.3"}

    monkeypatch.setattr("app.cropper.birefnet.load_session", _fake_load)
    return calls


class TestStartupHookRoleGate:
    """`_verify_baked_weights` is the startup model-load seam.

    Only the HEAVY role loads a model at startup; the FAST role skips both the
    baked-weight check and the session load even when REQUIRE_BAKED_WEIGHTS is
    still set on the shared image.
    """

    def test_fast_role_skips_the_load_even_with_require_baked_weights(
        self, monkeypatch, load_calls
    ):
        monkeypatch.setenv("PREPROCESS_ROLE", "fast")
        monkeypatch.setenv("REQUIRE_BAKED_WEIGHTS", "1")
        # No baked model on disk — HEAVY would raise here; FAST must not even
        # look, and must never load the model.
        monkeypatch.setenv("BIREFNET_HOME", "/nonexistent-birefnet-home")
        sam_calls: list[bool] = []
        # No role loads SAM at startup (NEO-315: it lazy-loads on first use).
        monkeypatch.setattr("app.cropper.sam._load_model", lambda: sam_calls.append(True))

        _verify_baked_weights()  # returns cleanly, no raise

        assert load_calls == []
        assert sam_calls == []

    def test_heavy_role_without_require_baked_weights_is_a_noop(self, monkeypatch, load_calls):
        # The unit-test default: REQUIRE_BAKED_WEIGHTS unset → no weight check
        # and no session load.
        monkeypatch.delenv("PREPROCESS_ROLE", raising=False)
        monkeypatch.delenv("REQUIRE_BAKED_WEIGHTS", raising=False)

        _verify_baked_weights()

        assert load_calls == []

    def test_heavy_role_with_require_baked_weights_but_no_weights_raises(
        self, monkeypatch, load_calls
    ):
        # Baked weights required but missing → the startup hook fails loudly.
        monkeypatch.delenv("PREPROCESS_ROLE", raising=False)
        monkeypatch.setenv("REQUIRE_BAKED_WEIGHTS", "1")
        monkeypatch.setenv("BIREFNET_HOME", "/nonexistent-birefnet-home")

        with pytest.raises(RuntimeError, match="REQUIRE_BAKED_WEIGHTS"):
            _verify_baked_weights()
        assert load_calls == []

    def test_module_exposes_the_role_constants(self):
        # Terraform/Convex references these role names; pin them.
        assert main.ROLE_FAST == "fast"
        assert main.ROLE_HEAVY == "heavy"
        assert main.PREPROCESS_ROLE_ENV == "PREPROCESS_ROLE"


COLD_START_KEYS = {
    "msg",
    "role",
    "exec_env",
    "isa",
    "cpu_model",
    "nproc",
    "main_module_import_s",
    "session_load_s",
    "startup_hook_s",
    "process_age_at_ready_s",
    "prewarm",
}


@pytest.fixture
def timing_lines():
    lines: list[str] = []

    class _Collect(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            lines.append(record.getMessage())

    handler = _Collect()
    timing.timing_logger.addHandler(handler)
    yield lines
    timing.timing_logger.removeHandler(handler)


def _cold_start_bodies(lines: list[str]) -> list[dict]:
    bodies = [json.loads(line) for line in lines]
    return [b for b in bodies if b.get("msg") == "cold_start"]


class TestColdStartLine:
    """NEO-484 C: one `cold_start` JSON line per boot, on the bare-JSON logger."""

    def test_heavy_boot_logs_one_line_with_the_session_load(
        self, monkeypatch, tmp_path, load_calls, timing_lines
    ):
        monkeypatch.delenv("PREPROCESS_ROLE", raising=False)
        monkeypatch.setenv("REQUIRE_BAKED_WEIGHTS", "1")
        monkeypatch.setenv("BIREFNET_HOME", str(tmp_path))
        monkeypatch.delenv("BIREFNET_MODEL", raising=False)
        (tmp_path / "birefnet-general.onnx").write_bytes(b"stub")

        _verify_baked_weights()

        assert load_calls == [True]
        assert len(timing_lines) == 1
        (body,) = _cold_start_bodies(timing_lines)
        assert set(body) == COLD_START_KEYS
        assert body["role"] == "heavy"
        assert body["session_load_s"] == 3.25
        assert body["prewarm"] is None
        assert body["exec_env"] in {"gen1", "gen2", "local"}
        assert isinstance(body["isa"], str) and body["isa"]
        assert isinstance(body["cpu_model"], str) and body["cpu_model"]
        assert isinstance(body["nproc"], int) and body["nproc"] >= 1
        assert isinstance(body["main_module_import_s"], float)
        assert body["main_module_import_s"] > 0
        assert body["startup_hook_s"] >= 0
        age = body["process_age_at_ready_s"]
        assert age is None or age >= 0

    def test_fast_boot_logs_a_line_without_a_session_load(
        self, monkeypatch, load_calls, timing_lines
    ):
        monkeypatch.setenv("PREPROCESS_ROLE", "fast")
        monkeypatch.setenv("REQUIRE_BAKED_WEIGHTS", "1")

        _verify_baked_weights()

        assert load_calls == []
        (body,) = _cold_start_bodies(timing_lines)
        assert body["role"] == "fast"
        assert body["session_load_s"] is None

    def test_a_boot_without_the_flag_still_logs_the_line(
        self, monkeypatch, load_calls, timing_lines
    ):
        monkeypatch.delenv("PREPROCESS_ROLE", raising=False)
        monkeypatch.delenv("REQUIRE_BAKED_WEIGHTS", raising=False)

        _verify_baked_weights()

        (body,) = _cold_start_bodies(timing_lines)
        assert body["role"] == "heavy"
        assert body["session_load_s"] is None

    def test_a_failed_weights_check_logs_no_line(self, monkeypatch, load_calls, timing_lines):
        monkeypatch.delenv("PREPROCESS_ROLE", raising=False)
        monkeypatch.setenv("REQUIRE_BAKED_WEIGHTS", "1")
        monkeypatch.setenv("BIREFNET_HOME", "/nonexistent-birefnet-home")

        with pytest.raises(RuntimeError):
            _verify_baked_weights()
        assert timing_lines == []

    def test_a_broken_host_probe_never_fails_the_boot(self, monkeypatch, load_calls, timing_lines):
        def _boom():
            raise RuntimeError("cpuinfo exploded")

        monkeypatch.setattr(main, "_host_facts", _boom)
        monkeypatch.delenv("REQUIRE_BAKED_WEIGHTS", raising=False)

        _verify_baked_weights()  # no raise

        assert _cold_start_bodies(timing_lines) == []

    def test_line_carries_no_env_values(self, monkeypatch, tmp_path, load_calls, timing_lines):
        monkeypatch.delenv("PREPROCESS_ROLE", raising=False)
        monkeypatch.setenv("REQUIRE_BAKED_WEIGHTS", "1")
        monkeypatch.setenv("BIREFNET_HOME", str(tmp_path))
        monkeypatch.setenv("INTERNAL_API_KEY", "a-secret-internal-key")
        (tmp_path / "birefnet-general.onnx").write_bytes(b"stub")

        _verify_baked_weights()

        (raw,) = timing_lines
        assert "a-secret-internal-key" not in raw
        assert str(tmp_path) not in raw


class TestHostFacts:
    def test_gvisor_kernel_is_gen1(self):
        version = "Linux version 4.4.0 #1 SMP Sun Jan 10 15:06:54 PST 2016"
        assert main._exec_env(version, {"K_SERVICE": "svc"}) == "gen1"

    def test_a_kernel_naming_gvisor_is_gen1(self):
        assert main._exec_env("Linux version 4.19.0-gvisor", {"K_SERVICE": "svc"}) == "gen1"

    def test_other_cloud_run_is_gen2(self):
        version = "Linux version 6.1.0-28-cloud-amd64 (debian-kernel@lists.debian.org)"
        assert main._exec_env(version, {"K_SERVICE": "svc"}) == "gen2"
        assert main._exec_env(version, {"CLOUD_RUN_JOB": "job"}) == "gen2"

    def test_anything_else_is_local(self):
        assert main._exec_env("", {}) == "local"

    def test_cpu_facts_read_the_first_processor_in_flag_order(self):
        cpuinfo = (
            "processor\t: 0\n"
            "model name\t: AMD  EPYC 7B13\n"
            "flags\t\t: fpu avx2 sse4_1 avx fma avx512f\n"
            "processor\t: 1\n"
            "model name\t: Something Else\n"
            "flags\t\t: fpu\n"
        )
        isa, model = main._cpu_facts(cpuinfo, "x86_64")
        assert model == "AMD EPYC 7B13"
        assert isa == "x86_64+sse4_1+avx+fma+avx2+avx512f"

    def test_cpu_facts_without_cpuinfo(self):
        assert main._cpu_facts("", "arm64") == ("arm64", "unknown")
