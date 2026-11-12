"""The SDK prewarm thread (NEO-484 C6) and why it cannot deadlock (Risk 8).

The startup hook starts `app.prewarm` on a daemon thread, which imports the
cloud SDKs while a request thread may be importing the same SDK on first use.
Python takes one import lock per module, so the question is whether two
threads importing at once can ever hang, or hand one of them a module that is
still half initialised. The tests below pin each half of the argument the
module docstring makes:

- the caller of `start()` never waits for the thread;
- a request thread that imports a module the prewarm thread is still
  importing WAITS for it and then sees the finished module, never a partial
  one (deterministic, with a module that blocks mid-import);
- the real SDKs, imported concurrently by the prewarm thread and by request
  threads in every order, in a fresh interpreter, all finish fully
  initialised within a timeout. A hang fails the test (the subprocess is
  killed) instead of hanging the suite;
- a failed import is recorded and the thread carries on.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import textwrap
import threading
import types
import uuid
from pathlib import Path

import pytest

from app import prewarm, timing
from tests.unit._prewarm_gate import returns_within

SERVICE_ROOT = Path(__file__).resolve().parents[2]
TIMEOUT_S = 30.0


@pytest.fixture(autouse=True)
def _fresh_run():
    prewarm._reset_for_tests()
    yield
    for thread in threading.enumerate():
        if thread.name == prewarm.THREAD_NAME:
            thread.join(timeout=TIMEOUT_S)
    prewarm._reset_for_tests()


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


def test_the_sdks_and_their_order_are_pinned():
    # Storage first (the batch routes touch it first), Anthropic last (used
    # last in a request, and the slowest import).
    assert prewarm.SDK_MODULES == ("google.cloud.storage", "google.cloud.vision", "anthropic")


class TestRun:
    def test_start_returns_at_once_while_the_import_is_held(self):
        gate = threading.Event()
        try:
            returned, thread = returns_within(
                lambda: prewarm.start(["m1"], importer=lambda _name: gate.wait(TIMEOUT_S)),
                2.0,
            )
            assert returned, "start() waited for the prewarm thread"
            assert thread is not None and thread.daemon
            assert thread.name == prewarm.THREAD_NAME
            snap = prewarm.snapshot()
            assert snap["state"] == "running"
            assert snap["imported_s"] == {}
        finally:
            gate.set()

    def test_start_is_once_per_process(self):
        first = prewarm.start([], importer=lambda _name: None)
        second = prewarm.start([], importer=lambda _name: None)
        assert first is not None
        assert second is None

    def test_snapshot_is_none_before_any_start(self):
        assert prewarm.snapshot() is None

    def test_imports_in_order_records_times_and_one_line(self, timing_lines):
        asked: list[str] = []
        thread = prewarm.start(["a", "b", "c"], importer=asked.append)
        thread.join(TIMEOUT_S)

        assert asked == ["a", "b", "c"]
        snap = prewarm.snapshot()
        assert snap["state"] == "done"
        assert list(snap["imported_s"]) == ["a", "b", "c"]
        assert all(v >= 0 for v in snap["imported_s"].values())
        assert snap["failed"] == []
        (line,) = timing_lines
        body = json.loads(line)
        assert body["msg"] == prewarm.PREWARM_MSG
        assert set(body) == {"msg", "state", "elapsed_s", "imported_s", "failed"}
        assert body["state"] == "done"

    def test_a_failed_import_is_recorded_and_the_rest_still_run(self, timing_lines):
        def _importer(name: str) -> None:
            if name == "broken":
                raise ImportError("No module named 'broken'")

        thread = prewarm.start(["a", "broken", "c"], importer=_importer)
        thread.join(TIMEOUT_S)

        snap = prewarm.snapshot()
        assert snap["state"] == "done"
        assert snap["failed"] == ["broken"]
        assert list(snap["imported_s"]) == ["a", "c"]
        (line,) = timing_lines
        assert json.loads(line)["failed"] == ["broken"]

    def test_the_default_importer_is_importlib(self):
        thread = prewarm.start(["json"])
        thread.join(TIMEOUT_S)
        assert prewarm.snapshot()["imported_s"].keys() == {"json"}


class TestImportLockHandoff:
    """A request importing what the prewarm thread is mid-way through waits, then gets it whole."""

    def test_request_thread_waits_for_the_in_flight_import_and_sees_it_complete(
        self, tmp_path, monkeypatch
    ):
        tag = uuid.uuid4().hex[:12]
        control_name = f"_c6_control_{tag}"
        probe_name = f"_c6_probe_{tag}"
        control = types.ModuleType(control_name)
        control.entered = threading.Event()
        control.release = threading.Event()
        monkeypatch.setitem(sys.modules, control_name, control)
        (tmp_path / f"{probe_name}.py").write_text(
            textwrap.dedent(
                f"""
                import {control_name} as ctl
                PARTIAL = True
                ctl.entered.set()
                assert ctl.release.wait({TIMEOUT_S})
                COMPLETE = True
                """
            )
        )
        monkeypatch.syspath_prepend(str(tmp_path))
        try:
            prewarm_thread = prewarm.start([probe_name])
            assert control.entered.wait(TIMEOUT_S), "prewarm never began the import"

            seen: dict[str, object] = {}

            def _request() -> None:
                try:
                    import importlib

                    module = importlib.import_module(probe_name)
                    seen["complete"] = getattr(module, "COMPLETE", False)
                except BaseException as exc:  # noqa: BLE001 - reported below
                    seen["error"] = repr(exc)

            request = threading.Thread(target=_request, name="request")
            request.start()
            # The request is parked on the module's import lock, not handed
            # the half-built module.
            request.join(0.3)
            assert request.is_alive()
            assert seen == {}

            control.release.set()
            request.join(TIMEOUT_S)
            prewarm_thread.join(TIMEOUT_S)
            assert not request.is_alive(), "request thread hung on the import lock"
            assert not prewarm_thread.is_alive(), "prewarm thread hung"
            assert seen == {"complete": True}
            assert prewarm.snapshot()["imported_s"].keys() == {probe_name}
        finally:
            control.release.set()
            sys.modules.pop(probe_name, None)


# Run in a fresh interpreter so none of the SDKs is imported yet: the prewarm
# thread and the request threads really race on the same cold imports. Each
# request thread goes through the same accessor production code uses and checks
# the module is fully initialised. The main thread meanwhile imports
# onnxruntime when it is installed, as the heavy role's session load does.
_RACE = """
import json, sys, threading, time
order = {order!r}

from app import prewarm
from app.classify import anthropic_sdk
from app.orient import vision_sdk


def _storage():
    from google.cloud import storage
    return storage


ACCESS = {{
    "anthropic": lambda: anthropic_sdk().Anthropic,
    "google.cloud.vision": lambda: vision_sdk().ImageAnnotatorClient,
    "google.cloud.storage": lambda: _storage().Client,
}}
barrier = threading.Barrier(len(order) + 1)
results, errors = {{}}, {{}}


def _request(i, name):
    try:
        barrier.wait(30)
        results[f"{{i}}:{{name}}"] = ACCESS[name]().__name__
    except BaseException as exc:
        errors[f"{{i}}:{{name}}"] = repr(exc)


threads = [threading.Thread(target=_request, args=(i, n)) for i, n in enumerate(order)]
for t in threads:
    t.start()
prewarm.start()
barrier.wait(30)
try:
    import onnxruntime  # noqa: F401
except ImportError:
    pass
deadline = time.monotonic() + {join_s}
for t in threads:
    t.join(max(0.0, deadline - time.monotonic()))
hung = [t.name for t in threads if t.is_alive()]
pw = [t for t in threading.enumerate() if t.name == prewarm.THREAD_NAME]
for t in pw:
    t.join(max(0.0, deadline - time.monotonic()))
hung += [t.name for t in pw if t.is_alive()]
print(json.dumps({{"results": results, "errors": errors, "hung": hung,
                  "prewarm": prewarm.snapshot()}}))
"""

_ORDERS = {
    "same-order": ["google.cloud.storage", "google.cloud.vision", "anthropic"],
    "reverse-order": ["anthropic", "google.cloud.vision", "google.cloud.storage"],
    "all-on-one": ["anthropic", "anthropic", "google.cloud.vision", "google.cloud.vision"],
}


@pytest.mark.parametrize("order", list(_ORDERS.values()), ids=list(_ORDERS))
def test_real_sdks_imported_concurrently_never_hang_or_come_back_partial(order):
    join_s = 90
    done = subprocess.run(
        [sys.executable, "-c", _RACE.format(order=order, join_s=join_s)],
        cwd=SERVICE_ROOT,
        env={**os.environ, "PYTHONPATH": str(SERVICE_ROOT)},
        capture_output=True,
        text=True,
        # A real deadlock never prints; the kill turns it into a failure.
        timeout=join_s + 30,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    out = json.loads(done.stdout.strip().splitlines()[-1])
    assert out["hung"] == []
    assert out["errors"] == {}
    expected = {
        "anthropic": "Anthropic",
        "google.cloud.vision": "ImageAnnotatorClient",
        "google.cloud.storage": "Client",
    }
    assert out["results"] == {f"{i}:{n}": expected[n] for i, n in enumerate(order)}
    assert out["prewarm"]["state"] == "done"
    assert out["prewarm"]["failed"] == []
    assert set(out["prewarm"]["imported_s"]) == set(prewarm.SDK_MODULES)
