"""Unit tests for app.cropper.tiebreak.

The tie-breaker is advisory by design — it is consulted only where geometry
has already declared the candidates equally card-shaped, and every failure
path has to leave the geometric winner standing. These tests pin that
containment rather than the model's taste, which no unit test can assert.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image

from app.cropper import tiebreak


def _jpeg(size: tuple[int, int]) -> bytes:
    img = Image.new("RGB", size, color=(120, 120, 120))
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=85)
    return out.getvalue()


class _Reply:
    def __init__(self, text: str) -> None:
        self.content = [type("Block", (), {"text": text})()]


class _Client:
    """Minimal anthropic stand-in; records the payload it was handed."""

    def __init__(self, text: str = "A") -> None:
        self._text = text
        self.calls: list[dict] = []
        self.messages = self

    def create(self, **kwargs):  # noqa: ANN003
        self.calls.append(kwargs)
        return _Reply(self._text)


class TestEnabledFlag:
    def test_off_by_default(self, monkeypatch):
        monkeypatch.delenv(tiebreak.ENABLED_ENV, raising=False)
        assert tiebreak.is_enabled() is False

    def test_on_only_for_exactly_one(self, monkeypatch):
        monkeypatch.setenv(tiebreak.ENABLED_ENV, "1")
        assert tiebreak.is_enabled() is True
        monkeypatch.setenv(tiebreak.ENABLED_ENV, "true")
        assert tiebreak.is_enabled() is False


class TestMateriality:
    """What keeps the call rare — 10.6% of the corpus instead of 66%."""

    def test_near_identical_crops_are_not_worth_asking_about(self):
        candidates = [("a", _jpeg((1000, 1400))), ("b", _jpeg((990, 1390)))]
        assert tiebreak.differ_materially(candidates) is False

    def test_a_third_of_the_card_missing_is_worth_asking_about(self):
        # The 2026-08-11-0003 shape: 103% of frame against 68%.
        candidates = [("a", _jpeg((1016, 1402))), ("b", _jpeg((815, 1147)))]
        assert tiebreak.differ_materially(candidates) is True

    def test_a_single_candidate_is_never_material(self):
        assert tiebreak.differ_materially([("a", _jpeg((1000, 1400)))]) is False

    def test_unreadable_bytes_do_not_raise(self):
        assert tiebreak.differ_materially([("a", b"nope"), ("b", b"also nope")]) is False


class TestPickBest:
    def test_returns_the_chosen_candidates_label(self):
        client = _Client("B")
        candidates = [("deskew", _jpeg((500, 700))), ("pil_trim_dark", _jpeg((400, 560)))]
        assert tiebreak.pick_best(candidates, client=client) == "pil_trim_dark"

    def test_strategy_names_are_withheld_from_the_model(self):
        """Otherwise a standing preference could pass itself off as judgement."""
        client = _Client("A")
        candidates = [("deskew", _jpeg((500, 700))), ("pil_trim_dark", _jpeg((400, 560)))]
        tiebreak.pick_best(candidates, client=client)

        sent = client.calls[0]["messages"][0]["content"]
        text = " ".join(part.get("text", "") for part in sent if part["type"] == "text")
        assert "deskew" not in text
        assert "pil_trim" not in text

    @pytest.mark.parametrize("reply", ["", "Z", "I cannot tell", "   "])
    def test_an_unusable_reply_keeps_the_geometric_pick(self, reply):
        candidates = [("deskew", _jpeg((500, 700))), ("pil_trim_dark", _jpeg((400, 560)))]
        assert tiebreak.pick_best(candidates, client=_Client(reply)) is None

    def test_a_raising_client_keeps_the_geometric_pick(self):
        class _Boom:
            def __init__(self) -> None:
                self.messages = self

            def create(self, **_kwargs):  # noqa: ANN003
                raise RuntimeError("upstream is down")

        candidates = [("deskew", _jpeg((500, 700))), ("pil_trim_dark", _jpeg((400, 560)))]
        assert tiebreak.pick_best(candidates, client=_Boom()) is None

    def test_fewer_than_two_candidates_is_not_a_question(self):
        client = _Client("A")
        assert tiebreak.pick_best([("deskew", _jpeg((500, 700)))], client=client) is None
        assert client.calls == []

    def test_the_prompt_leads_with_the_unrecoverable_failure(self):
        """Clipping is the one thing that cannot be fixed downstream."""
        client = _Client("A")
        candidates = [("deskew", _jpeg((500, 700))), ("pil_trim_dark", _jpeg((400, 560)))]
        tiebreak.pick_best(candidates, client=client)

        sent = client.calls[0]["messages"][0]["content"]
        prompt = [p for p in sent if p["type"] == "text"][-1]["text"]
        assert "ENTIRE card must be present" in prompt
        assert prompt.index("ENTIRE card") < prompt.index("least surrounding")
