"""Unit tests for app.classify.

Anthropic SDK is mocked. Fixtures cover: happy path, markdown-wrapped JSON,
malformed-JSON with retry success, malformed both attempts, empty response
block, missing/unknown side value, and a non-existent image payload.
"""

from __future__ import annotations

import io
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from PIL import Image

from app.classify import (
    ANTHROPIC_MAX_RAW_BYTES,
    PROMPT,
    RETRY_PROMPT_SUFFIX,
    ClassifyError,
    _detect_media_type,
    _prepare_for_anthropic,
    _strip_code_fences,
    classify_card,
)


def _png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), color="white").save(buf, format="PNG")
    return buf.getvalue()


def _jpeg_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), color="white").save(buf, format="JPEG")
    return buf.getvalue()


def _response_with_text(text: str) -> SimpleNamespace:
    return SimpleNamespace(content=[SimpleNamespace(text=text)])


def _empty_response() -> SimpleNamespace:
    return SimpleNamespace(content=[])


def _mock_client(*responses: SimpleNamespace) -> MagicMock:
    client = MagicMock()
    client.messages.create.side_effect = list(responses)
    return client


class TestHelpers:
    def test_strip_code_fences_with_language_tag(self):
        wrapped = '```json\n{"a":1}\n```'
        assert _strip_code_fences(wrapped) == '{"a":1}'

    def test_strip_code_fences_no_fence(self):
        assert _strip_code_fences('{"a":1}') == '{"a":1}'

    def test_strip_code_fences_preserves_inner_whitespace(self):
        wrapped = '```\n{\n  "a": 1\n}\n```'
        assert _strip_code_fences(wrapped) == '{\n  "a": 1\n}'

    def test_detect_media_type_png(self):
        assert _detect_media_type(_png_bytes()) == "image/png"

    def test_detect_media_type_jpeg(self):
        assert _detect_media_type(_jpeg_bytes()) == "image/jpeg"

    def test_detect_media_type_garbage_falls_back_to_jpeg(self):
        assert _detect_media_type(b"not an image") == "image/jpeg"


class TestPrepareForAnthropic:
    def test_small_image_passes_through_unchanged(self):
        original = _jpeg_bytes()
        assert len(original) <= ANTHROPIC_MAX_RAW_BYTES

        payload, media_type = _prepare_for_anthropic(original)

        assert payload == original
        assert media_type == "image/jpeg"

    def test_large_image_is_downscaled_to_fit(self):
        # A realistic phone-shot-sized PNG: 4000×3000 ≈ 48MP of noise that
        # compresses poorly. Ensures the downscale path actually kicks in.
        import os

        big = io.BytesIO()
        Image.frombytes(
            "RGB",
            (4000, 3000),
            os.urandom(4000 * 3000 * 3),
        ).save(big, format="PNG")
        oversized = big.getvalue()
        assert len(oversized) > ANTHROPIC_MAX_RAW_BYTES

        payload, media_type = _prepare_for_anthropic(oversized)

        assert len(payload) <= ANTHROPIC_MAX_RAW_BYTES
        # Always re-encoded as JPEG when downscaling.
        assert media_type == "image/jpeg"
        with Image.open(io.BytesIO(payload)) as result:
            # Longest edge must be at or below the downscale cap.
            assert max(result.size) <= 1600


class TestClassifyCard:
    def test_happy_path_returns_parsed_fields(self):
        payload = (
            '{"player":"Ken Griffey Jr.","team":"Mariners",' '"card_number":"24","side":"front"}'
        )
        client = _mock_client(_response_with_text(payload))

        result = classify_card(_jpeg_bytes(), client=client)

        assert result.player == "Ken Griffey Jr."
        assert result.team == "Mariners"
        assert result.card_number == "24"
        assert result.side == "front"
        assert result.raw_text == payload
        assert client.messages.create.call_count == 1

    def test_markdown_wrapped_json_parses(self):
        payload = '```json\n{"player":"Jordan","team":null,"card_number":"23","side":"back"}\n```'
        client = _mock_client(_response_with_text(payload))

        result = classify_card(_jpeg_bytes(), client=client)

        assert result.player == "Jordan"
        assert result.team is None
        assert result.card_number == "23"
        assert result.side == "back"

    def test_malformed_first_response_retries_and_succeeds(self):
        bad = "Here is the JSON you requested: not-actually-json"
        good = '{"player":"Pujols","team":"Cardinals","card_number":"5","side":"front"}'
        client = _mock_client(_response_with_text(bad), _response_with_text(good))

        result = classify_card(_jpeg_bytes(), client=client)

        assert result.player == "Pujols"
        assert client.messages.create.call_count == 2
        retry_call = client.messages.create.call_args_list[1]
        retry_prompt = retry_call.kwargs["messages"][0]["content"][1]["text"]
        assert retry_prompt.startswith(PROMPT)
        assert RETRY_PROMPT_SUFFIX.strip() in retry_prompt

    def test_malformed_both_attempts_raises(self):
        client = _mock_client(
            _response_with_text("nope"),
            _response_with_text("still not json"),
        )

        with pytest.raises(ClassifyError, match="could not be parsed"):
            classify_card(_jpeg_bytes(), client=client)

        assert client.messages.create.call_count == 2

    def test_empty_response_block_retries(self):
        # First call returns no content blocks at all; second returns valid JSON.
        good = '{"player":"Ohtani","team":"Angels","card_number":"17","side":"front"}'
        client = _mock_client(_empty_response(), _response_with_text(good))

        result = classify_card(_jpeg_bytes(), client=client)

        assert result.player == "Ohtani"
        assert client.messages.create.call_count == 2

    def test_unknown_side_normalizes_to_front(self):
        payload = '{"player":"Trout","team":null,"card_number":null,"side":"left"}'
        client = _mock_client(_response_with_text(payload))

        result = classify_card(_jpeg_bytes(), client=client)

        assert result.side == "front"

    def test_missing_keys_return_nulls(self):
        # Model skips optional keys; `side` missing → defaults to "front".
        payload = '{"player":"Rookie","card_number":""}'
        client = _mock_client(_response_with_text(payload))

        result = classify_card(_jpeg_bytes(), client=client)

        assert result.player == "Rookie"
        assert result.team is None
        assert result.card_number is None  # empty string normalizes to None
        assert result.side == "front"

    def test_empty_image_bytes_raises_value_error(self):
        client = _mock_client()

        with pytest.raises(ValueError, match="empty"):
            classify_card(b"", client=client)

        client.messages.create.assert_not_called()

    def test_sends_correct_media_type_for_png(self):
        payload = '{"player":null,"team":null,"card_number":null,"side":"front"}'
        client = _mock_client(_response_with_text(payload))

        classify_card(_png_bytes(), client=client)

        call = client.messages.create.call_args
        image_block = call.kwargs["messages"][0]["content"][0]
        assert image_block["source"]["media_type"] == "image/png"

    def test_multi_player_response_collects_players_list(self):
        payload = (
            '{"players":["Salvador Perez","Adam Duvall","Fernando Tatis"],'
            '"team":null,"card_number":"68","side":"back"}'
        )
        client = _mock_client(_response_with_text(payload))

        result = classify_card(_jpeg_bytes(), client=client)

        assert result.players == ["Salvador Perez", "Adam Duvall", "Fernando Tatis"]
        assert result.player == "Salvador Perez"  # back-compat property
        assert result.team is None
        assert result.card_number == "68"
        assert result.side == "back"

    def test_list_response_is_merged_not_crashed(self):
        # Haiku occasionally wraps multi-player output in a top-level list.
        # Previously this crashed _normalize with 'list has no attribute get'.
        payload = (
            "["
            '{"player":"Ken Griffey Jr.","team":"Mariners","card_number":"24","side":"front"},'
            '{"player":"Randy Johnson","team":"Mariners","card_number":"24","side":"front"}'
            "]"
        )
        client = _mock_client(_response_with_text(payload))

        result = classify_card(_jpeg_bytes(), client=client)

        assert result.players == ["Ken Griffey Jr.", "Randy Johnson"]
        assert result.team == "Mariners"
        assert result.card_number == "24"
        assert result.side == "front"

    def test_legacy_player_string_still_works(self):
        # Old single-player JSON shape remains parseable for back-compat.
        payload = '{"player":"Ichiro","team":"Mariners","card_number":"51","side":"front"}'
        client = _mock_client(_response_with_text(payload))

        result = classify_card(_jpeg_bytes(), client=client)

        assert result.players == ["Ichiro"]
        assert result.player == "Ichiro"

    def test_empty_players_list_accepted(self):
        payload = '{"players":[],"team":null,"card_number":null,"side":"back"}'
        client = _mock_client(_response_with_text(payload))

        result = classify_card(_jpeg_bytes(), client=client)

        assert result.players == []
        assert result.player is None
        assert result.side == "back"

    def test_uses_explicit_model_when_provided(self):
        payload = '{"player":null,"team":null,"card_number":null,"side":"front"}'
        client = _mock_client(_response_with_text(payload))

        classify_card(_jpeg_bytes(), client=client, model="claude-test-model")

        call = client.messages.create.call_args
        assert call.kwargs["model"] == "claude-test-model"
