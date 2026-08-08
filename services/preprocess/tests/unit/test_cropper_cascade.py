"""Unit tests for app.cropper.crop — the cascade orchestrator.

Slice 3 folded precropped into the same uniform-gate loop as every other
strategy. Every stage now:
  1. Validator (is_plausible_crop)
  2. Text-count regression guard (against baseline orient on raw image)
  3. Classify call (no classify-level gate — result is packaged as-is)

Tests stub `detect_orientation` and `classify_card` on the `cropper`
module binding because that's where `crop()` imports them.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image

from app import cropper
from app.classify import ClassifyResult
from app.cropper import CropRejected, CropResult, crop
from app.orient import OrientationResult


def _card_jpeg(*, size: tuple[int, int] = (500, 700)) -> bytes:
    import random

    rng = random.Random(size[0] * 31 + size[1])
    raw = bytes(rng.randint(0, 255) for _ in range(size[0] * size[1] * 3))
    img = Image.frombytes("RGB", size, raw)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=85)
    return out.getvalue()


def _tiny_jpeg() -> bytes:
    return _card_jpeg(size=(100, 140))


def _orient(
    *,
    text_count: int = 10,
    rotation: int = 0,
    confidence: float = 1.0,
) -> OrientationResult:
    return OrientationResult(
        rotation_degrees=rotation, confidence=confidence, text_count=text_count
    )


def _classify(
    *,
    player: str | None = "Ichiro",
    team: str | None = "Mariners",
    card_number: str | None = "51",
    side: str = "front",
) -> ClassifyResult:
    return ClassifyResult(
        players=[player] if player else [],
        team=team,
        card_number=card_number,
        side=side,
        raw_text="{}",
    )


@pytest.fixture
def stub_orient(monkeypatch):
    """Install an orient stub that returns the same result for every call."""

    def _install(result: OrientationResult | None = None) -> list[bytes]:
        result = result or _orient()
        calls: list[bytes] = []

        def _fake(b: bytes) -> OrientationResult:
            calls.append(b)
            return result

        monkeypatch.setattr(cropper, "detect_orientation", _fake)
        return calls

    return _install


@pytest.fixture
def stub_orient_by_call(monkeypatch):
    """Install an orient stub that returns successive queued results in order."""

    def _install(*results: OrientationResult) -> list[bytes]:
        queue = list(results)
        calls: list[bytes] = []

        def _fake(b: bytes) -> OrientationResult:
            calls.append(b)
            return queue.pop(0) if queue else _orient()

        monkeypatch.setattr(cropper, "detect_orientation", _fake)
        return calls

    return _install


@pytest.fixture
def stub_classify(monkeypatch):
    """Install a classify stub that returns successive queued results in order."""

    def _install(*results: ClassifyResult) -> list[bytes]:
        queue = list(results)
        calls: list[bytes] = []

        def _fake(b: bytes) -> ClassifyResult:
            calls.append(b)
            return queue.pop(0) if queue else _classify()

        monkeypatch.setattr(cropper, "classify_card", _fake)
        return calls

    return _install


@pytest.fixture
def disable_server_strategies(monkeypatch):
    """Factory to stub out the server-side croppers so only precropped runs.

    Returns a helper that accepts kwargs for each strategy (default None).
    Any not explicitly overridden returns None (skipped by cascade).
    """

    def _install(**overrides) -> None:
        defaults = {
            "trim_dark": None,
            "trim_light": None,
            "sam_crop": None,
            "haiku_bbox_crop": None,
        }
        defaults.update(overrides)
        monkeypatch.setattr("app.cropper.pil_trim.trim_dark", lambda _b: defaults["trim_dark"])
        monkeypatch.setattr("app.cropper.pil_trim.trim_light", lambda _b: defaults["trim_light"])
        monkeypatch.setattr("app.cropper.sam.sam_crop", lambda _b: defaults["sam_crop"])
        monkeypatch.setattr(
            "app.cropper.haiku_bbox.haiku_bbox_crop", lambda _b: defaults["haiku_bbox_crop"]
        )

    return _install


class TestPrecroppedStage:
    def test_valid_precropped_wins(self, stub_orient, stub_classify, disable_server_strategies):
        stub_orient()
        stub_classify(_classify())
        disable_server_strategies()

        image = _card_jpeg(size=(1200, 1600))
        precropped = _card_jpeg(size=(500, 700))

        result = crop(image_bytes=image, precropped_bytes=precropped)

        assert result.source == "precropped"
        assert result.image_bytes == precropped
        assert result.returned_bytes_differ is False
        assert result.classification.players == ["Ichiro"]

    def test_missing_precropped_uses_image_candidate(
        self, stub_orient, stub_classify, disable_server_strategies
    ):
        stub_orient()
        stub_classify(_classify())
        disable_server_strategies()

        image = _card_jpeg(size=(500, 700))

        result = crop(image_bytes=image, precropped_bytes=None)

        assert result.source == "precropped"
        assert result.image_bytes == image
        assert result.returned_bytes_differ is False

    def test_precropped_fails_validator_falls_through(
        self, stub_orient, stub_classify, disable_server_strategies
    ):
        # Tiny precropped fails the min-side check → falls through to server stages.
        good_trim = _card_jpeg(size=(500, 700))
        stub_orient()
        stub_classify(_classify())
        disable_server_strategies(trim_dark=good_trim)

        image = _card_jpeg(size=(1200, 1600))
        bad_precropped = _tiny_jpeg()

        result = crop(image_bytes=image, precropped_bytes=bad_precropped)

        assert result.source == "pil_trim_dark"
        assert result.image_bytes == good_trim
        assert result.returned_bytes_differ is True

    def test_precropped_fails_text_count_gate_falls_through(
        self, stub_orient_by_call, stub_classify, disable_server_strategies
    ):
        """Precropped passes validator but has text_count below threshold."""
        good_trim = _card_jpeg(size=(500, 700))
        disable_server_strategies(trim_dark=good_trim)

        # Baseline text=10 → threshold=8. Precropped returns text=5 (fails gate).
        # pil_trim_dark then returns text=10 (wins).
        stub_orient_by_call(
            _orient(text_count=10),  # baseline (raw image)
            _orient(text_count=5),  # precropped — fails gate
            _orient(text_count=10),  # pil_trim_dark output
        )
        stub_classify(_classify())  # pil_trim_dark's classify

        image = _card_jpeg(size=(1200, 1600))
        precropped = _card_jpeg(size=(500, 700))  # passes validator but low text

        result = crop(image_bytes=image, precropped_bytes=precropped)

        assert result.source == "pil_trim_dark"


class TestPilTrimStages:
    def test_pil_trim_dark_wins_when_it_produces_good_output(
        self, stub_orient, stub_classify, disable_server_strategies
    ):
        good = _card_jpeg(size=(500, 700))
        stub_orient()
        stub_classify(_classify())
        disable_server_strategies(trim_dark=good)

        image = _card_jpeg(size=(1200, 1600))
        bad_precropped = _tiny_jpeg()

        result = crop(image_bytes=image, precropped_bytes=bad_precropped)

        assert result.source == "pil_trim_dark"
        assert result.returned_bytes_differ is True

    def test_pil_trim_light_wins_when_dark_returns_none(
        self, stub_orient, stub_classify, disable_server_strategies
    ):
        good = _card_jpeg(size=(500, 700))
        stub_orient()
        stub_classify(_classify())
        disable_server_strategies(trim_dark=None, trim_light=good)

        image = _card_jpeg(size=(1200, 1600))
        bad_precropped = _tiny_jpeg()

        result = crop(image_bytes=image, precropped_bytes=bad_precropped)

        assert result.source == "pil_trim_light"
        assert result.returned_bytes_differ is True

    def test_pil_trim_text_count_drop_falls_through_to_sam(
        self, stub_orient_by_call, stub_classify, disable_server_strategies
    ):
        """pil_trim_dark passes validator but drops too much text → SAM runs."""
        good = _card_jpeg(size=(500, 700))
        disable_server_strategies(trim_dark=good, sam_crop=good)

        # baseline=10 → threshold=8. precropped (100x140) fails validator so
        # no orient. pil_trim_dark output text=5 (fails gate). SAM output text=10 (wins).
        stub_orient_by_call(
            _orient(text_count=10),  # baseline
            _orient(text_count=5),  # pil_trim_dark output
            _orient(text_count=10),  # sam output
        )
        stub_classify(_classify())

        image = _card_jpeg(size=(1200, 1600))
        bad_precropped = _tiny_jpeg()

        result = crop(image_bytes=image, precropped_bytes=bad_precropped)

        assert result.source == "sam"


class TestSamStage:
    def test_valid_sam_wins_when_trim_variants_empty(
        self, stub_orient, stub_classify, disable_server_strategies
    ):
        good = _card_jpeg(size=(500, 700))
        stub_orient()
        stub_classify(_classify())
        disable_server_strategies(sam_crop=good)

        image = _card_jpeg(size=(1200, 1600))
        bad_precropped = _tiny_jpeg()

        result = crop(image_bytes=image, precropped_bytes=bad_precropped)

        assert result.source == "sam"

    def test_sam_raises_falls_through_to_haiku_bbox(self, stub_orient, stub_classify, monkeypatch):
        good = _card_jpeg(size=(500, 700))
        monkeypatch.setattr("app.cropper.pil_trim.trim_dark", lambda _b: None)
        monkeypatch.setattr("app.cropper.pil_trim.trim_light", lambda _b: None)

        def _boom(_b):
            raise RuntimeError("SAM crashed")

        monkeypatch.setattr("app.cropper.sam.sam_crop", _boom)
        monkeypatch.setattr("app.cropper.haiku_bbox.haiku_bbox_crop", lambda _b: good)

        stub_orient()
        stub_classify(_classify())

        image = _card_jpeg(size=(1200, 1600))
        bad_precropped = _tiny_jpeg()

        result = crop(image_bytes=image, precropped_bytes=bad_precropped)

        assert result.source == "haiku_bbox"


class TestHaikuBboxStage:
    def test_haiku_bbox_wins_when_earlier_fail(
        self, stub_orient, stub_classify, disable_server_strategies
    ):
        good = _card_jpeg(size=(500, 700))
        stub_orient()
        stub_classify(_classify())
        disable_server_strategies(haiku_bbox_crop=good)

        image = _card_jpeg(size=(1200, 1600))
        bad_precropped = _tiny_jpeg()

        result = crop(image_bytes=image, precropped_bytes=bad_precropped)

        assert result.source == "haiku_bbox"
        assert result.returned_bytes_differ is True

    def test_haiku_bbox_raises_falls_through_to_passthrough(
        self, stub_orient, stub_classify, monkeypatch
    ):
        monkeypatch.setattr("app.cropper.pil_trim.trim_dark", lambda _b: None)
        monkeypatch.setattr("app.cropper.pil_trim.trim_light", lambda _b: None)
        monkeypatch.setattr("app.cropper.sam.sam_crop", lambda _b: None)

        def _boom(_b):
            raise RuntimeError("anthropic down")

        monkeypatch.setattr("app.cropper.haiku_bbox.haiku_bbox_crop", _boom)

        stub_orient()
        stub_classify(_classify())

        image = _card_jpeg(size=(1200, 1600))
        bad_precropped = _tiny_jpeg()

        result = crop(image_bytes=image, precropped_bytes=bad_precropped)

        assert result.source == "passthrough"


class TestPassthroughFallback:
    def test_all_stages_fail_returns_passthrough(
        self, stub_orient, stub_classify, disable_server_strategies
    ):
        stub_orient()
        stub_classify(_classify())
        disable_server_strategies()  # all None

        image = _card_jpeg(size=(1200, 1600))
        bad_precropped = _tiny_jpeg()

        result = crop(image_bytes=image, precropped_bytes=bad_precropped)

        assert result.source == "passthrough"
        assert result.image_bytes == image
        assert result.returned_bytes_differ is False

    def test_passthrough_carries_empty_players_when_unidentifiable(
        self, stub_orient, stub_classify, disable_server_strategies
    ):
        """All stages fail + classify returns empty fields → passthrough is honest."""
        stub_orient()
        stub_classify(_classify(player=None, team=None, card_number=None, side="back"))
        disable_server_strategies()

        image = _card_jpeg(size=(1200, 1600))
        bad_precropped = _tiny_jpeg()

        result = crop(image_bytes=image, precropped_bytes=bad_precropped)

        assert result.source == "passthrough"
        assert result.classification.players == []
        assert result.classification.card_number is None
        assert result.classification.side == "back"


class TestCropOnlyMode:
    """Crop-only mode: caller provides only `precropped_bytes`, no original.

    The cascade has no fallback path here — it either returns a normal
    CropResult (crop passed the adapted two-gate check) or a CropRejected
    with a specific reason so main.py can surface a 422.
    """

    def test_valid_crop_returns_crop_result(self, stub_orient, stub_classify):
        stub_orient()
        stub_classify(_classify())

        crop_bytes = _card_jpeg(size=(500, 700))
        result = crop(image_bytes=None, precropped_bytes=crop_bytes)

        assert isinstance(result, CropResult)
        assert result.source == "precropped"
        assert result.image_bytes == crop_bytes
        assert result.returned_bytes_differ is False
        assert result.classification.players == ["Ichiro"]

    def test_too_small_crop_rejected(self, stub_orient, stub_classify):
        # Orient/classify stubs set but shouldn't be reached on validator reject.
        orient_calls = stub_orient()
        classify_calls = stub_classify(_classify())

        tiny = _card_jpeg(size=(100, 140))
        result = crop(image_bytes=None, precropped_bytes=tiny)

        assert isinstance(result, CropRejected)
        assert "too small" in result.reason
        assert orient_calls == []  # no orient on a validator-rejected crop
        assert classify_calls == []

    def test_wrong_aspect_rejected(self, stub_orient, stub_classify):
        stub_orient()
        stub_classify(_classify())

        square = _card_jpeg(size=(600, 600))
        result = crop(image_bytes=None, precropped_bytes=square)

        assert isinstance(result, CropRejected)
        assert "aspect" in result.reason

    def test_insufficient_text_rejected(self, stub_orient, stub_classify):
        # Crop passes geometry but Vision finds no text — treat as not-a-card.
        stub_orient(_orient(text_count=0))
        classify_calls = stub_classify(_classify())

        crop_bytes = _card_jpeg(size=(500, 700))
        result = crop(image_bytes=None, precropped_bytes=crop_bytes)

        assert isinstance(result, CropRejected)
        assert result.reason == "insufficient_text"
        # classify must not run when the crop is rejected upstream
        assert classify_calls == []

    def test_blank_image_rejected(self, stub_orient, stub_classify):
        stub_orient()
        stub_classify(_classify())

        # Solid white passes geometry but fails the stddev check.
        buf = io.BytesIO()
        Image.new("RGB", (500, 700), color="white").save(buf, format="JPEG")
        blank = buf.getvalue()

        result = crop(image_bytes=None, precropped_bytes=blank)

        assert isinstance(result, CropRejected)
        assert "near-uniform" in result.reason

    def test_both_none_raises(self):
        with pytest.raises(ValueError, match="at least one"):
            crop(image_bytes=None, precropped_bytes=None)

    def test_rotation_applied_before_classify(self, stub_orient, stub_classify):
        # Sanity: crop-only path still rotates the crop before classify.
        stub_orient(_orient(rotation=90))
        classify_calls = stub_classify(_classify())

        # Valid card-ratio crop so it passes validator.
        crop_bytes = _card_jpeg(size=(500, 700))
        result = crop(image_bytes=None, precropped_bytes=crop_bytes)

        assert isinstance(result, CropResult)
        assert len(classify_calls) == 1
        # After CCW-90, the 500x700 crop should be seen by classify as 700x500.
        with Image.open(io.BytesIO(classify_calls[0])) as rotated:
            assert rotated.size == (700, 500)


class TestCropResultShape:
    def test_is_immutable_dataclass(self, stub_orient, stub_classify, disable_server_strategies):
        stub_orient()
        stub_classify(_classify())
        disable_server_strategies()
        result = crop(image_bytes=_card_jpeg(), precropped_bytes=None)
        with pytest.raises(AttributeError):
            result.source = "other"  # type: ignore[misc]

    def test_carries_orientation_and_classification(
        self, stub_orient, stub_classify, disable_server_strategies
    ):
        stub_orient(_orient(text_count=42, rotation=90, confidence=0.77))
        stub_classify(_classify(player="Jeter", team="Yankees", card_number="2"))
        disable_server_strategies()
        result: CropResult = crop(image_bytes=_card_jpeg(), precropped_bytes=None)
        assert result.orientation.text_count == 42
        assert result.orientation.rotation_degrees == 90
        assert result.classification.players == ["Jeter"]
        assert result.classification.card_number == "2"
