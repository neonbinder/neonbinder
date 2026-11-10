"""Hold the startup hook's SDK prewarm thread (NEO-484 C6) for a test.

`_verify_baked_weights` starts `app.prewarm` on every call. Left alone, that
thread would really import the SDKs and then write a `prewarm` line on the
`timing` logger at some moment the test does not control, which a test
counting that logger's lines would catch at random. `hold_prewarm` swaps the
thread's importer for one that records the module name and waits on a gate,
so the run stays `running` (a fixed snapshot) for the whole test; teardown
opens the gate, joins the thread and forgets the run.

Use it from an autouse fixture: `yield from hold_prewarm(monkeypatch)`.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterator
from typing import Any

from app import prewarm

JOIN_TIMEOUT_S = 30.0


def _join_prewarm_threads() -> None:
    for thread in threading.enumerate():
        if thread.name == prewarm.THREAD_NAME and thread is not threading.current_thread():
            thread.join(timeout=JOIN_TIMEOUT_S)


def hold_prewarm(monkeypatch) -> Iterator[list[str]]:
    """Yield the list of module names the held thread was asked to import."""
    gate = threading.Event()
    asked: list[str] = []

    def _held_import(name: str) -> None:
        asked.append(name)
        gate.wait(timeout=JOIN_TIMEOUT_S)

    # A run left by another test (or a real one) must not leak into this one.
    _join_prewarm_threads()
    prewarm._reset_for_tests()
    monkeypatch.setattr(prewarm, "_import", _held_import)
    try:
        yield asked
    finally:
        gate.set()
        _join_prewarm_threads()
        prewarm._reset_for_tests()


def returns_within(fn: Callable[[], Any], seconds: float) -> tuple[bool, Any]:
    """Call `fn` on a daemon thread; `(True, result)` if it returned in time.

    A call that blocks on the held prewarm thread then fails the test in
    `seconds` instead of hanging it: the caller's teardown opens the gate,
    which lets the blocked call finish.
    """
    box: dict[str, Any] = {}
    done = threading.Event()

    def _call() -> None:
        try:
            box["result"] = fn()
        finally:
            done.set()

    threading.Thread(target=_call, name="returns-within", daemon=True).start()
    return done.wait(seconds), box.get("result")
