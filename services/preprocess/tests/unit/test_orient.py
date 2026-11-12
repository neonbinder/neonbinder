"""Unit tests for app.orient.

External calls are mocked; each test builds a fake Vision response with a
known geometry and asserts the snapped rotation. Mirrors the four cardinal
orientations plus ambiguous and empty-text cases called out in the plan.
"""

from __future__ import annotations

import io
import logging
import threading
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from google.api_core.exceptions import (
    DeadlineExceeded,
    InternalServerError,
    InvalidArgument,
    ResourceExhausted,
    ServiceUnavailable,
)
from PIL import Image

from app import orient
from app.exif import EXIF_ORIENTATION_TAG, read_exif_orientation
from app.orient import detect_orientation
from app.timing import Timings, bound


def _vertex(x: int, y: int) -> SimpleNamespace:
    return SimpleNamespace(x=x, y=y)


def _word(*corners: tuple[int, int]) -> SimpleNamespace:
    """Build a fake EntityAnnotation with a bounding_poly of the given corners.

    Corners must be given in text-local [TL, TR, BR, BL] order.
    """
    return SimpleNamespace(
        bounding_poly=SimpleNamespace(vertices=[_vertex(x, y) for x, y in corners])
    )


def _make_response(word_polys: list[SimpleNamespace]) -> SimpleNamespace:
    # text_annotations[0] is Vision's full-document bbox; the code skips it.
    full_doc = _word((0, 0), (100, 0), (100, 100), (0, 100))
    return SimpleNamespace(
        text_annotations=[full_doc, *word_polys],
        error=SimpleNamespace(message=""),
    )


def _mock_client(response: SimpleNamespace) -> MagicMock:
    client = MagicMock()
    client.text_detection.return_value = response
    return client


def _jpeg_of_at_least(size: tuple[int, int], min_bytes: int, orientation: int | None = None):
    """A real JPEG padded past its end marker, so a decode stays cheap.

    Trailing bytes make it as large as a test needs without encoding noise.
    """
    img = Image.new("RGB", size, (200, 30, 30))
    out = io.BytesIO()
    if orientation is None:
        img.save(out, format="JPEG")
    else:
        exif = img.getexif()
        exif[EXIF_ORIENTATION_TAG] = orientation
        img.save(out, format="JPEG", exif=exif)
    return out.getvalue().ljust(min_bytes, b"\x00")


def _sent_to_vision(image_bytes: bytes) -> bytes:
    """The bytes `detect_orientation` hands the Vision client for this input."""
    client = _mock_client(_make_response([]))
    detect_orientation(image_bytes, client=client)
    return client.text_detection.call_args.kwargs["image"].content


class TestShrinkForVision:
    def test_at_the_threshold_is_byte_identical(self):
        original = _jpeg_of_at_least((6144, 8160), orient.VISION_SHRINK_ABOVE_BYTES)
        assert len(original) == orient.VISION_SHRINK_ABOVE_BYTES
        assert _sent_to_vision(original) == original

    def test_small_image_is_byte_identical(self):
        original = _jpeg_of_at_least((64, 48), 0)
        assert _sent_to_vision(original) == original

    def test_above_the_threshold_sends_a_smaller_jpeg(self):
        original = _jpeg_of_at_least((6144, 8160), orient.VISION_SHRINK_ABOVE_BYTES + 1)

        sent = _sent_to_vision(original)

        assert len(sent) < len(original)
        with Image.open(io.BytesIO(sent)) as img:
            assert img.format == "JPEG"
            assert max(img.size) == orient.VISION_SHRINK_MAX_EDGE_PX
            # 6144:8160 at a long edge of 4096, so scale cannot skew an angle.
            assert img.size == (3084, 4096)

    def test_above_the_threshold_does_not_upscale(self):
        original = _jpeg_of_at_least((1000, 1400), orient.VISION_SHRINK_ABOVE_BYTES + 1)

        with Image.open(io.BytesIO(_sent_to_vision(original))) as img:
            assert img.size == (1000, 1400)

    def test_orientation_tag_survives_the_shrink(self):
        original = _jpeg_of_at_least((5000, 4000), orient.VISION_SHRINK_ABOVE_BYTES + 1, 6)
        assert read_exif_orientation(_sent_to_vision(original)) == 6

    def test_unreadable_oversize_bytes_go_to_vision_as_they_are(self):
        # Vision's own error is the better diagnosis than a Pillow one.
        original = b"not an image".ljust(orient.VISION_SHRINK_ABOVE_BYTES + 1, b"\x00")
        assert _sent_to_vision(original) == original

    def test_rgba_above_the_threshold_still_encodes(self):
        out = io.BytesIO()
        Image.new("RGBA", (64, 48), (1, 2, 3, 4)).save(out, format="PNG")
        original = out.getvalue().ljust(orient.VISION_SHRINK_ABOVE_BYTES + 1, b"\x00")

        with Image.open(io.BytesIO(_sent_to_vision(original))) as img:
            assert img.format == "JPEG"

    def test_the_shrink_is_on_the_reconnect_path_too(self, monkeypatch):
        # A retry after a dropped stream must send the same shrunk bytes.
        original = _jpeg_of_at_least((5000, 4000), orient.VISION_SHRINK_ABOVE_BYTES + 1)
        stale = MagicMock()
        stale.text_detection.side_effect = ServiceUnavailable("stream removed")
        fresh = _mock_client(_make_response([]))
        monkeypatch.setattr(orient, "_client", stale)
        monkeypatch.setattr(orient.vision_sdk(), "ImageAnnotatorClient", lambda: fresh)

        detect_orientation(original)

        first = stale.text_detection.call_args.kwargs["image"].content
        second = fresh.text_detection.call_args.kwargs["image"].content
        assert first == second
        assert len(second) < len(original)


class TestDetectOrientation:
    def test_upright_text_returns_zero(self):
        # TL=(10,10), TR=(50,10): top edge points right (dx=40, dy=0).
        words = [_word((10, 10), (50, 10), (50, 30), (10, 30)) for _ in range(5)]
        client = _mock_client(_make_response(words))

        result = detect_orientation(b"fake-image", client=client)

        assert result.rotation_degrees == 0
        assert result.confidence == 1.0
        assert result.text_count == 5

    def test_text_rotated_90cw_returns_90(self):
        # Text reads top-to-bottom in image. TL at image-top-right,
        # TR is below it. Top edge vector: dx=0, dy>0 → angle 90°.
        words = [_word((100, 10), (100, 50), (80, 50), (80, 10)) for _ in range(4)]
        client = _mock_client(_make_response(words))

        result = detect_orientation(b"fake-image", client=client)

        assert result.rotation_degrees == 90
        assert result.confidence == 1.0
        assert result.text_count == 4

    def test_upside_down_text_returns_180(self):
        # TL at image-bottom-right, TR at image-bottom-left (dx<0, dy=0).
        words = [_word((50, 50), (10, 50), (10, 30), (50, 30)) for _ in range(3)]
        client = _mock_client(_make_response(words))

        result = detect_orientation(b"fake-image", client=client)

        assert result.rotation_degrees == 180
        assert result.confidence == 1.0
        assert result.text_count == 3

    def test_text_rotated_90ccw_returns_270(self):
        # Top edge vector points up (dx=0, dy<0) → angle 270°.
        words = [_word((10, 100), (10, 60), (30, 60), (30, 100)) for _ in range(2)]
        client = _mock_client(_make_response(words))

        result = detect_orientation(b"fake-image", client=client)

        assert result.rotation_degrees == 270
        assert result.confidence == 1.0
        assert result.text_count == 2

    def test_empty_text_returns_zero_with_zero_confidence(self):
        client = _mock_client(_make_response([]))

        result = detect_orientation(b"fake-image", client=client)

        assert result.rotation_degrees == 0
        assert result.confidence == 0.0
        assert result.text_count == 0

    def test_mixed_angles_picks_majority(self):
        # Three upright words, one rotated 90° CW. Majority wins.
        upright = [_word((10, 10), (50, 10), (50, 30), (10, 30)) for _ in range(3)]
        rotated = [_word((100, 10), (100, 50), (80, 50), (80, 10))]
        client = _mock_client(_make_response(upright + rotated))

        result = detect_orientation(b"fake-image", client=client)

        assert result.rotation_degrees == 0
        assert result.confidence == pytest.approx(0.75)
        assert result.text_count == 4

    def test_near_45_snaps_to_nearest_quadrant(self):
        # Top edge at ~44° (dx=50, dy=48) snaps to 0. At ~46° snaps to 90.
        # This exercises the rounding boundary.
        words_44 = [_word((0, 0), (50, 48), (70, 78), (20, 30)) for _ in range(2)]
        client = _mock_client(_make_response(words_44))
        assert detect_orientation(b"fake", client=client).rotation_degrees == 0

        words_46 = [_word((0, 0), (48, 50), (78, 70), (30, 20)) for _ in range(2)]
        client = _mock_client(_make_response(words_46))
        assert detect_orientation(b"fake", client=client).rotation_degrees == 90

    def test_vision_api_error_raises(self):
        response = SimpleNamespace(
            text_annotations=[],
            error=SimpleNamespace(message="quota exceeded"),
        )
        client = _mock_client(response)

        with pytest.raises(RuntimeError, match="quota exceeded"):
            detect_orientation(b"fake-image", client=client)

    def test_degenerate_vertices_are_skipped(self):
        # A word with fewer than 2 vertices contributes no vote; other words
        # still tally. Ensures we don't crash on malformed Vision output.
        good = [_word((10, 10), (50, 10), (50, 30), (10, 30)) for _ in range(2)]
        bad = [SimpleNamespace(bounding_poly=SimpleNamespace(vertices=[_vertex(0, 0)]))]
        client = _mock_client(_make_response(good + bad))

        result = detect_orientation(b"fake-image", client=client)

        assert result.rotation_degrees == 0
        assert result.text_count == 2

    def test_all_degenerate_vertices_returns_zero(self):
        # Every word has <2 vertices. Bucket is empty; fall through to zero.
        bad = [
            SimpleNamespace(bounding_poly=SimpleNamespace(vertices=[_vertex(0, 0)]))
            for _ in range(3)
        ]
        client = _mock_client(_make_response(bad))

        result = detect_orientation(b"fake-image", client=client)

        assert result.rotation_degrees == 0
        assert result.confidence == 0.0
        assert result.text_count == 0


@pytest.fixture
def shared_client_factory(monkeypatch):
    """Reset the process-wide client and install a scripted client factory.

    `script(*behaviours)` queues one behaviour per client the code builds; each
    behaviour is a list of per-call outcomes for that client's text_detection
    (an exception instance to raise, or a response to return; the last one
    repeats). Returns the list of built clients for assertions.
    """
    from app import orient

    monkeypatch.setattr(orient, "_client", None)
    built: list[MagicMock] = []
    queued: list[list[object]] = []

    def _factory():
        outcomes = queued.pop(0) if queued else [_make_response(_upright_words(3))]
        client = MagicMock()

        def _call(**_kwargs):
            outcome = outcomes[min(client.text_detection.call_count - 1, len(outcomes) - 1)]
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome

        client.text_detection.side_effect = _call
        built.append(client)
        return client

    monkeypatch.setattr(orient.vision_sdk(), "ImageAnnotatorClient", _factory)

    def script(*behaviours: list[object]) -> list[MagicMock]:
        queued.extend(behaviours)
        return built

    return script


def _upright_words(n: int) -> list[SimpleNamespace]:
    return [_word((10, 10), (50, 10), (50, 30), (10, 30)) for _ in range(n)]


def _attempts(built: list[MagicMock]) -> int:
    return sum(c.text_detection.call_count for c in built)


class TestSharedVisionClient:
    """NEO-315 D2: one lazily built Vision client per process."""

    def test_default_client_is_built_once_and_reused(self, shared_client_factory):
        built = shared_client_factory()

        for _ in range(5):
            detect_orientation(b"img")

        assert len(built) == 1
        assert built[0].text_detection.call_count == 5

    def test_concurrent_cold_requests_build_one_client(self, shared_client_factory):
        built = shared_client_factory()
        barrier = threading.Barrier(4)

        def _cold_request():
            barrier.wait()
            detect_orientation(b"img")

        threads = [threading.Thread(target=_cold_request) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(built) == 1
        assert built[0].text_detection.call_count == 4

    def test_explicit_client_bypasses_the_shared_one(self, monkeypatch):
        from app import orient

        def _refuse():
            raise AssertionError("shared client must not be built when one is injected")

        monkeypatch.setattr(orient, "_client", None)
        monkeypatch.setattr(orient.vision_sdk(), "ImageAnnotatorClient", _refuse)
        client = _mock_client(_make_response([]))

        detect_orientation(b"img", client=client)

        assert client.text_detection.call_count == 1


class TestVisionReconnect:
    """NEO-315: on gRPC UNAVAILABLE from the shared client, rebuild it and retry
    exactly once; nothing else is retried."""

    def test_unavailable_then_success_rebuilds_and_retries_once(
        self, shared_client_factory, caplog
    ):
        built = shared_client_factory(
            [ServiceUnavailable("Stream removed")],
            [_make_response(_upright_words(4))],
        )
        timings = Timings()

        with caplog.at_level(logging.WARNING, logger="app.orient"), bound(timings):
            result = detect_orientation(b"img")

        assert result.rotation_degrees == 0
        assert result.text_count == 4
        assert len(built) == 2
        assert built[0] is not built[1]
        assert [c.text_detection.call_count for c in built] == [1, 1]
        assert timings.vision_reconnects == 1
        # The fresh client is now the shared one: the next call reuses it.
        detect_orientation(b"img")
        assert len(built) == 2
        assert built[1].text_detection.call_count == 2
        # One warning, naming the exception class and nothing else.
        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert len(warnings) == 1
        assert "ServiceUnavailable" in warnings[0].getMessage()
        assert "Stream removed" not in warnings[0].getMessage()

    def test_two_consecutive_unavailable_propagate_after_one_retry(self, shared_client_factory):
        second = ServiceUnavailable("still down")
        built = shared_client_factory(
            [ServiceUnavailable("Stream removed")],
            [second],
        )
        timings = Timings()

        with bound(timings), pytest.raises(ServiceUnavailable) as caught:
            detect_orientation(b"img")

        assert caught.value is second
        assert caught.value.__context__ is None
        assert _attempts(built) == 2
        assert len(built) == 2
        assert timings.vision_reconnects == 1

    @pytest.mark.parametrize(
        "error",
        [
            ResourceExhausted("quota"),
            DeadlineExceeded("slow"),
            InvalidArgument("bad image"),
            InternalServerError("500"),
            ConnectionError("raw socket"),
        ],
        ids=lambda e: type(e).__name__,
    )
    def test_other_exceptions_propagate_without_retry(self, shared_client_factory, error):
        built = shared_client_factory([error])
        timings = Timings()

        with bound(timings), pytest.raises(type(error)):
            detect_orientation(b"img")

        assert _attempts(built) == 1
        assert len(built) == 1
        assert timings.vision_reconnects == 0

    def test_in_body_error_raises_without_retry(self, shared_client_factory):
        # RESOURCE_EXHAUSTED and other per-image errors arrive in the response
        # body, not as an exception. Product decision: no Vision retry for them.
        in_body = SimpleNamespace(
            text_annotations=[],
            error=SimpleNamespace(message="RESOURCE_EXHAUSTED: quota exceeded"),
        )
        built = shared_client_factory([in_body])

        with pytest.raises(RuntimeError, match="RESOURCE_EXHAUSTED"):
            detect_orientation(b"img")

        assert _attempts(built) == 1
        assert len(built) == 1

    def test_injected_client_is_never_rebuilt_or_retried(self, monkeypatch):
        from app import orient

        def _refuse():
            raise AssertionError("an injected client must never be rebuilt")

        monkeypatch.setattr(orient, "_client", None)
        monkeypatch.setattr(orient.vision_sdk(), "ImageAnnotatorClient", _refuse)
        client = MagicMock()
        client.text_detection.side_effect = ServiceUnavailable("Stream removed")

        with pytest.raises(ServiceUnavailable):
            detect_orientation(b"img", client=client)

        assert client.text_detection.call_count == 1

    def test_concurrent_unavailable_on_one_stale_client_rebuilds_once(self, shared_client_factory):
        # Two requests hit the same dead channel at the same moment. The first
        # through the lock rebuilds; the second must adopt that fresh client,
        # not build (and orphan) another one.
        barrier = threading.Barrier(2)

        def _both_in_flight_then_fail(**_kwargs):
            barrier.wait()
            raise ServiceUnavailable("Stream removed")

        built = shared_client_factory([], [_make_response(_upright_words(2))])
        stale = orient.get_vision_client()
        stale.text_detection.side_effect = _both_in_flight_then_fail
        results: list[int] = []
        counts: list[int] = []

        def _request():
            t = Timings()
            with bound(t):
                results.append(detect_orientation(b"img").text_count)
            counts.append(t.vision_reconnects)

        threads = [threading.Thread(target=_request) for _ in range(2)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()

        assert results == [2, 2]
        # Built: the stale client, then exactly one replacement.
        assert len(built) == 2
        assert stale.text_detection.call_count == 2
        assert built[1].text_detection.call_count == 2
        # Each request retried once, so each records its own reconnect.
        assert counts == [1, 1]
