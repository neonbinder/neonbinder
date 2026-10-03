"""Unit tests for app.timing (NEO-315).

The accumulator is per request, never shared; the JSON line has a fixed key
set Cloud Logging queries depend on; the dedicated logger must not propagate
(or the root handler would prefix the JSON and Cloud Logging would store it as
text); and `measure_current` is a no-op unless a request is bound, and only
ever sees its own request's object.
"""

from __future__ import annotations

import json
import logging
import threading
import time

import pytest

from app import timing
from app.timing import Timings, bound, increment_current, measure_current

EXPECTED_KEYS = {
    "msg",
    "role",
    "index",
    "gcs_ms",
    "exif_ms",
    "dhash_ms",
    "vision_calls",
    "vision_ms",
    "vision_reconnects",
    "classical_ms",
    "birefnet_ms",
    "sam_ms",
    "haiku_bbox_ms",
    "classify_ms",
    "classify_retried",
    "rotate_ms",
    "write_ms",
    "total_ms",
    "source",
    "escalated",
    "baseline_supplied",
    "haiku_bbox_reached",
    "haiku_bbox_won",
}


class _Collect(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(record.getMessage())


@pytest.fixture
def collected():
    handler = _Collect()
    timing.timing_logger.addHandler(handler)
    yield handler.lines
    timing.timing_logger.removeHandler(handler)


class TestTimings:
    def test_measure_accumulates_into_the_named_field(self):
        t = Timings()
        with t.measure("vision_ms"):
            time.sleep(0.01)
        with t.measure("vision_ms"):
            time.sleep(0.01)
        assert t.vision_ms >= 20

    def test_measure_records_even_when_the_body_raises(self):
        t = Timings()
        with pytest.raises(RuntimeError), t.measure("write_ms"):
            time.sleep(0.005)
            raise RuntimeError("boom")
        assert t.write_ms >= 5

    def test_unknown_field_is_refused(self):
        with pytest.raises(ValueError, match="unknown timing field"):
            with Timings().measure("vision_calls"):
                pass

    def test_payload_has_exactly_the_contract_keys(self):
        body = Timings(role="heavy", index=3).payload()
        assert set(body) == EXPECTED_KEYS
        assert body["msg"] == "process_entry_timing"
        assert body["role"] == "heavy"
        assert body["index"] == 3

    def test_ms_fields_are_whole_numbers(self):
        t = Timings()
        t.vision_ms = 12.6
        body = t.payload()
        assert body["vision_ms"] == 13
        assert all(isinstance(body[k], int) for k in EXPECTED_KEYS if k.endswith("_ms"))


class TestEmit:
    def test_emits_one_parseable_json_line(self, collected):
        t = Timings(role="fast", index=0)
        t.vision_calls = 1
        t.escalated = True
        t.emit()
        assert len(collected) == 1
        body = json.loads(collected[0])
        assert body["vision_calls"] == 1
        assert body["vision_reconnects"] == 0
        assert body["escalated"] is True

    def test_logger_does_not_propagate_and_formats_the_bare_message(self):
        logger = logging.getLogger(timing.TIMING_LOGGER_NAME)
        assert logger.propagate is False
        assert logger.level == logging.INFO
        formatters = [h.formatter for h in logger.handlers if h.formatter is not None]
        assert any(f._fmt == "%(message)s" for f in formatters)

    def test_rebuilding_the_logger_does_not_double_handlers(self):
        before = len(logging.getLogger(timing.TIMING_LOGGER_NAME).handlers)
        timing._build_timing_logger()
        assert len(logging.getLogger(timing.TIMING_LOGGER_NAME).handlers) == before


class TestMeasureCurrent:
    def test_is_a_noop_when_nothing_is_bound(self):
        with measure_current("birefnet_ms"):
            pass  # must not raise

    def test_books_to_the_bound_request(self):
        t = Timings()
        with bound(t), measure_current("birefnet_ms"):
            time.sleep(0.01)
        assert t.birefnet_ms >= 10

    def test_unbinds_after_the_block(self):
        t = Timings()
        with bound(t):
            pass
        with measure_current("birefnet_ms"):
            time.sleep(0.005)
        assert t.birefnet_ms == 0

    def test_concurrent_requests_never_see_each_others_timings(self):
        # The FAST role runs several /process-entry requests concurrently.
        # Every thread binds its own Timings, waits until all four are bound,
        # and must still see only its own object.
        seen: dict[int, bool] = {}
        barrier = threading.Barrier(4)

        def _request(i: int) -> None:
            t = Timings(index=i)
            with bound(t):
                barrier.wait()
                seen[i] = timing._current.get() is t
                with measure_current("birefnet_ms"):
                    time.sleep(0.001)
            assert t.birefnet_ms > 0

        threads = [threading.Thread(target=_request, args=(i,)) for i in range(4)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()

        assert seen == {0: True, 1: True, 2: True, 3: True}


class TestIncrementCurrent:
    """The counter twin of `measure_current` (NEO-315 vision_reconnects)."""

    def test_is_a_noop_when_nothing_is_bound(self):
        increment_current("vision_reconnects")  # must not raise

    def test_counts_on_the_bound_request(self):
        t = Timings()
        with bound(t):
            increment_current("vision_reconnects")
            increment_current("vision_reconnects")
        assert t.vision_reconnects == 2
        assert t.payload()["vision_reconnects"] == 2

    def test_rejects_an_unknown_counter(self):
        with pytest.raises(ValueError, match="unknown counter"):
            increment_current("vision_reconnect")
