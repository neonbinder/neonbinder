"""Background import of the cloud SDKs after boot (NEO-484 C6).

`import app.main` used to import the Anthropic, Cloud Vision and Cloud Storage
SDKs at module level. On Cloud Run gen2 an image layer is read lazily, so a
cold import waits on disk: measured, `import app.main` took 15-38 s and
93-127 s in a tail, with only ~4 s of it CPU and most of the rest in
`anthropic`. None of the three is needed to answer the startup probe.

So each consumer imports its SDK on first use (`app.classify`,
`app.cropper.haiku_bbox`, `app.orient`, `app.jobs.gcs`), and the startup hook
calls `start()`, which imports them on a daemon thread while the hook carries
on (the heavy role loads its ORT session meanwhile). By the time a request
needs an SDK it is usually already in `sys.modules`; if not, the request
thread's own import waits for the one in flight.

**Why this cannot deadlock (Risk 8).** Python's import system takes a lock per
module, not one global lock, and a thread that imports a module another thread
is still initialising waits on that module's lock until the import completes,
then sees the finished module. The cases that can go wrong are excluded by
construction, and `tests/unit/test_prewarm.py` checks each:

- No thread ever waits *for this thread*: nothing joins it, nothing holds a
  lock it needs, and `start()` returns at once. A request blocks only on an
  import's module lock, which the importing thread always releases.
- `start()` is called from the startup hook, never while a module is being
  imported, so the spawning thread holds no import lock the worker could need
  (the classic "spawn a thread at import time and wait for it" hang).
- The worker only imports. It builds no client, reads no credentials and
  touches no shared state but its own record, so it cannot hold anything a
  request wants.

A failed import is logged and recorded, then the next module is tried. The
same ImportError then reaches the first request that needs that SDK, which is
accepted (J2): boot no longer proves the SDKs import, and the deploy smokes do.

One `prewarm` JSON line goes through the bare-JSON `timing` logger when the
thread finishes; the `cold_start` line carries `snapshot()` at the moment the
hook returns.
"""

from __future__ import annotations

import importlib
import json
import logging
import threading
import time
from collections.abc import Callable, Sequence
from typing import Any

from app.timing import timing_logger

logger = logging.getLogger(__name__)

PREWARM_MSG = "prewarm"
THREAD_NAME = "sdk-prewarm"

# Imported in this order: storage is what `/extract` and `/process-entry`
# touch first, then Vision (orient), then Anthropic (classify, last in a
# request and the slowest to import).
SDK_MODULES: tuple[str, ...] = ("google.cloud.storage", "google.cloud.vision", "anthropic")


class _Run:
    """What one prewarm run has done so far. Guarded by its own lock."""

    def __init__(self, modules: Sequence[str]) -> None:
        self.modules = tuple(modules)
        self.started = time.perf_counter()
        self.lock = threading.Lock()
        self.imported_s: dict[str, float] = {}
        self.failed: list[str] = []
        self.total_s: float | None = None

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            done = self.total_s is not None
            return {
                "state": "done" if done else "running",
                "elapsed_s": round(self.total_s if done else time.perf_counter() - self.started, 3),
                "imported_s": dict(self.imported_s),
                "failed": list(self.failed),
            }


_run: _Run | None = None
_start_lock = threading.Lock()


def _work(run: _Run, importer: Callable[[str], object]) -> None:
    for name in run.modules:
        began = time.perf_counter()
        try:
            importer(name)
        except Exception:  # noqa: BLE001 - a failed import must not kill the thread
            logger.warning("prewarm: import of %s failed", name, exc_info=True)
            with run.lock:
                run.failed.append(name)
            continue
        with run.lock:
            run.imported_s[name] = round(time.perf_counter() - began, 3)
    with run.lock:
        run.total_s = round(time.perf_counter() - run.started, 3)
    try:
        body = {"msg": PREWARM_MSG, **run.snapshot()}
        timing_logger.info(json.dumps(body, separators=(",", ":")))
    except Exception:  # noqa: BLE001 - a log line must never matter
        logger.exception("prewarm: could not write the prewarm line")


# The import function the thread calls. A module attribute, read when `start`
# runs, so a test can swap it for a recording fake.
_import: Callable[[str], object] = importlib.import_module


def start(
    modules: Sequence[str] | None = None,
    *,
    importer: Callable[[str], object] | None = None,
) -> threading.Thread | None:
    """Start the prewarm thread once per process; later calls return None.

    Returns at once. The thread is a daemon, so it never holds up shutdown, and
    nothing ever joins it on a request path. `modules` defaults to
    `SDK_MODULES` and `importer` to `importlib.import_module`; both exist for
    the tests.
    """
    global _run
    with _start_lock:
        if _run is not None:
            return None
        run = _Run(SDK_MODULES if modules is None else modules)
        thread = threading.Thread(
            target=_work,
            args=(run, _import if importer is None else importer),
            name=THREAD_NAME,
            daemon=True,
        )
        _run = run
    thread.start()
    return thread


def snapshot() -> dict[str, Any] | None:
    """The current run's progress for the `cold_start` line, or None if never started."""
    run = _run
    return run.snapshot() if run is not None else None


def _reset_for_tests() -> None:
    """Forget the current run so a test can call `start()` again."""
    global _run
    with _start_lock:
        _run = None
