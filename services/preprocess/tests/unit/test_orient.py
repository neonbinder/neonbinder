"""Unit tests for app.orient.

External calls are mocked; each test builds a fake Vision response with a
known geometry and asserts the snapped rotation. Mirrors the four cardinal
orientations plus ambiguous and empty-text cases called out in the plan.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.orient import detect_orientation


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
