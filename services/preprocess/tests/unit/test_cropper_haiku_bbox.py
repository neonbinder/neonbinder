"""Unit tests for app.cropper.haiku_bbox.

Anthropic SDK is mocked — no real Haiku calls. Covers parse helpers, the
downscale-coord rescaling, the crop step, and the error paths that must
return None rather than raise.
"""

from __future__ import annotations

import io
import json
from types import SimpleNamespace
from unittest.mock import MagicMock

from PIL import Image

from app.cropper.haiku_bbox import (
    _parse_bbox,
    _rescale_bbox,
    _strip_code_fences,
    haiku_bbox_crop,
)


def _response_with_text(text: str) -> SimpleNamespace:
    return SimpleNamespace(content=[SimpleNamespace(text=text)])


def _empty_response() -> SimpleNamespace:
    return SimpleNamespace(content=[])


def _mock_client(*responses: SimpleNamespace) -> MagicMock:
    client = MagicMock()
    client.messages.create.side_effect = list(responses)
    return client


def _png_bytes(size: tuple[int, int] = (1200, 1600), color: str = "white") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color=color).save(buf, format="PNG")
    return buf.getvalue()


def _jpeg_bytes(size: tuple[int, int] = (1200, 1600), color: str = "white") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color=color).save(buf, format="JPEG", quality=85)
    return buf.getvalue()


class TestParseBbox:
    def test_parses_plain_json(self):
        assert _parse_bbox('{"x": 10, "y": 20, "w": 300, "h": 420}') == (10, 20, 300, 420)

    def test_strips_code_fences(self):
        assert _parse_bbox('```json\n{"x": 0, "y": 0, "w": 100, "h": 140}\n```') == (
            0,
            0,
            100,
            140,
        )

    def test_rejects_zero_width(self):
        assert _parse_bbox('{"x": 0, "y": 0, "w": 0, "h": 100}') is None

    def test_rejects_negative_values(self):
        assert _parse_bbox('{"x": 0, "y": 0, "w": -5, "h": 100}') is None

    def test_rejects_missing_key(self):
        assert _parse_bbox('{"x": 0, "y": 0, "w": 100}') is None

    def test_rejects_non_dict_json(self):
        assert _parse_bbox("[1, 2, 3]") is None

    def test_rejects_invalid_json(self):
        assert _parse_bbox("not json at all") is None


class TestStripCodeFences:
    def test_no_fence(self):
        assert _strip_code_fences('{"a":1}') == '{"a":1}'

    def test_json_fence(self):
        assert _strip_code_fences('```json\n{"a":1}\n```') == '{"a":1}'

    def test_bare_fence(self):
        assert _strip_code_fences('```\n{"a":1}\n```') == '{"a":1}'


class TestRescaleBbox:
    def test_identity_when_sizes_match(self):
        result = _rescale_bbox(
            (10, 20, 100, 140),
            downscaled_size=(1200, 1600),
            original_size=(1200, 1600),
        )
        assert result == (10, 20, 100, 140)

    def test_scales_up_to_original_dimensions(self):
        # Downscaled 600x800, original 1200x1600 → 2x in each direction.
        result = _rescale_bbox(
            (50, 100, 300, 400),
            downscaled_size=(600, 800),
            original_size=(1200, 1600),
        )
        assert result == (100, 200, 600, 800)

    def test_clamps_bbox_that_overflows(self):
        # Haiku may return bounds past the image edge; we clamp to stay inside.
        result = _rescale_bbox(
            (500, 500, 200, 200),
            downscaled_size=(600, 600),
            original_size=(600, 600),
        )
        assert result == (500, 500, 100, 100)

    def test_returns_none_when_downscaled_size_invalid(self):
        assert (
            _rescale_bbox(
                (0, 0, 100, 100),
                downscaled_size=(0, 0),
                original_size=(1000, 1000),
            )
            is None
        )


class TestHaikuBboxCrop:
    def test_happy_path_returns_cropped_bytes(self):
        # Small source so _prepare_for_anthropic passes it through unchanged —
        # bbox coordinates land in the original coordinate space without
        # needing rescale.
        image = _jpeg_bytes(size=(1200, 1600))
        bbox_json = json.dumps({"x": 100, "y": 200, "w": 800, "h": 1100})
        client = _mock_client(_response_with_text(bbox_json))

        result = haiku_bbox_crop(image, client=client)

        assert result is not None
        with Image.open(io.BytesIO(result)) as out:
            # PIL's .crop truncates; the output should be close to 800x1100.
            assert abs(out.size[0] - 800) <= 2
            assert abs(out.size[1] - 1100) <= 2

    def test_bad_json_returns_none(self):
        image = _jpeg_bytes()
        client = _mock_client(_response_with_text("sorry I can't help with that"))

        assert haiku_bbox_crop(image, client=client) is None

    def test_haiku_explicit_no_card_returns_none(self):
        image = _jpeg_bytes()
        bbox_json = json.dumps({"x": 0, "y": 0, "w": 0, "h": 0})
        client = _mock_client(_response_with_text(bbox_json))

        assert haiku_bbox_crop(image, client=client) is None

    def test_empty_response_returns_none(self):
        image = _jpeg_bytes()
        client = _mock_client(_empty_response())

        assert haiku_bbox_crop(image, client=client) is None

    def test_empty_image_bytes_returns_none(self):
        client = _mock_client()
        assert haiku_bbox_crop(b"", client=client) is None
        client.messages.create.assert_not_called()

    def test_haiku_api_exception_returns_none(self):
        client = MagicMock()
        client.messages.create.side_effect = RuntimeError("anthropic down")

        image = _jpeg_bytes()
        assert haiku_bbox_crop(image, client=client) is None

    def test_passes_model_through(self):
        image = _jpeg_bytes()
        bbox_json = json.dumps({"x": 0, "y": 0, "w": 100, "h": 140})
        client = _mock_client(_response_with_text(bbox_json))

        haiku_bbox_crop(image, client=client, model="claude-test-model")

        call = client.messages.create.call_args
        assert call.kwargs["model"] == "claude-test-model"
        assert call.kwargs["temperature"] == 0.0

    def test_unreadable_image_returns_none(self):
        client = _mock_client(_response_with_text(json.dumps({"x": 0, "y": 0, "w": 10, "h": 10})))
        # _prepare_for_anthropic can handle garbage by returning it passthrough-ish,
        # but Image.open later will fail. haiku_bbox should catch that.
        assert haiku_bbox_crop(b"not an image at all", client=client) is None
