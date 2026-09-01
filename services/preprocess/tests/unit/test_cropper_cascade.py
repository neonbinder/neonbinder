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
from app.cropper import CropDeclined, CropRejected, CropResult, crop, scan_meta
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
            "tiered_crop": None,
            "trim_dark": None,
            "trim_light": None,
            "sam_crop": None,
            "haiku_bbox_crop": None,
        }
        defaults.update(overrides)
        monkeypatch.setattr("app.cropper.tiered.tiered_crop", lambda _b: defaults["tiered_crop"])
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

    def test_missing_precropped_does_not_short_circuit_the_cascade(
        self, stub_orient, stub_classify, disable_server_strategies
    ):
        """A raw upload is never treated as an implicit crop candidate.

        It used to be, and nothing could reject it: measured against itself
        the area fraction is exactly 1.0, and the text gate's threshold is
        0.8x a baseline counted on those same bytes. 184 of the 227 corpus
        images won at stage 1 that way and came back uncropped — every 3:4
        phone photo among them.

        With every strategy stubbed out there is nothing left to win, so
        reaching `passthrough` is what proves the cascade actually ran
        instead of stopping at stage 1.

        Pinned to "strong" so the NEO-173 fast pre-check (which reads a
        card-aspect noise frame as an identity short-circuit) does not stand
        in for the loop this test is about; the fast path has its own tests.
        """
        stub_orient()
        stub_classify(_classify())
        disable_server_strategies()

        image = _card_jpeg(size=(500, 700))

        result = crop(image_bytes=image, precropped_bytes=None, crop_quality="strong")

        assert result.source == "passthrough"
        assert result.image_bytes == image
        assert result.returned_bytes_differ is False

    def test_a_server_strategy_can_win_on_an_image_only_upload(
        self, stub_orient, stub_classify, disable_server_strategies
    ):
        """The point of the change: image-only requests reach the croppers.

        A 3:4 phone frame is only 5.4% off card aspect, so it cleared the old
        stage-1 gate and the cropper's output was never even computed.
        """
        cropped = _card_jpeg(size=(500, 700))
        stub_orient()
        stub_classify(_classify())
        disable_server_strategies(trim_dark=cropped)

        phone_frame = _card_jpeg(size=(768, 1020))  # 0.753 — inside ASPECT_TOLERANCE

        result = crop(image_bytes=phone_frame, precropped_bytes=None)

        assert result.source == "pil_trim_dark"
        assert result.image_bytes == cropped
        assert result.returned_bytes_differ is True

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


class TestTieredStage:
    def test_tiered_wins_ahead_of_pil_trim(
        self, stub_orient, stub_classify, disable_server_strategies
    ):
        """tiered is first in the cascade — its crop wins before pil_trim runs."""
        tiered_out = _card_jpeg(size=(500, 700))
        trim_out = _card_jpeg(size=(510, 714))
        stub_orient()
        stub_classify(_classify())
        disable_server_strategies(tiered_crop=tiered_out, trim_dark=trim_out)

        image = _card_jpeg(size=(1200, 1600))

        result = crop(image_bytes=image, precropped_bytes=None)

        assert result.source == "tiered"
        assert result.image_bytes == tiered_out
        assert result.returned_bytes_differ is True

    def test_tiered_declining_falls_through_to_pil_trim(
        self, stub_orient, stub_classify, disable_server_strategies
    ):
        """A decline (None) hands the image to the next strategy."""
        trim_out = _card_jpeg(size=(500, 700))
        stub_orient()
        stub_classify(_classify())
        disable_server_strategies(tiered_crop=None, trim_dark=trim_out)

        image = _card_jpeg(size=(1200, 1600))

        result = crop(image_bytes=image, precropped_bytes=None)

        assert result.source == "pil_trim_dark"
        assert result.image_bytes == trim_out

    def test_tiered_identity_echo_ends_the_cascade_with_the_input(
        self, stub_orient, stub_classify, disable_server_strategies
    ):
        """Identity returns the input bytes untouched — that must WIN the
        cascade (never reach pil_trim, which could shave a pre-cropped
        card's border) and must not be marked as server-modified bytes."""
        stub_orient()
        stub_classify(_classify())
        image = _card_jpeg(size=(1200, 1600))
        trim_out = _card_jpeg(size=(500, 700))
        disable_server_strategies(tiered_crop=image, trim_dark=trim_out)

        result = crop(image_bytes=image, precropped_bytes=None)

        assert result.source == "tiered"
        assert result.image_bytes == image
        assert result.returned_bytes_differ is False


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
        monkeypatch.setattr("app.cropper.tiered.tiered_crop", lambda _b: None)
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
        monkeypatch.setattr("app.cropper.tiered.tiered_crop", lambda _b: None)
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


class TestScanMetadataIdentity:
    """NEO-191: a frame the scanner says measures one card has nothing to crop.

    This sits ahead of the NEO-173 classical fast path in "fast" mode, so the
    assertions below are mostly about ORDER — which stages must not run once
    the metadata has settled it, and that a silent metadata verdict changes
    nothing about the stages that follow.

    `_card_jpeg` writes no resolution, so every other test in this file takes
    the `is_card_sized_scan → None` branch and is unaffected; the tests here
    stub the check directly rather than hand-building DPI fixtures, which
    `test_cropper_scan_meta.py` covers on its own.
    """

    def test_a_card_sized_scan_wins_before_any_pixel_work(
        self, monkeypatch, stub_orient, stub_classify, disable_server_strategies
    ):
        stub_orient()
        stub_classify(_classify())
        image = _card_jpeg(size=(500, 700))
        monkeypatch.setattr(
            "app.cropper.scan_meta.is_card_sized_scan",
            lambda _b: scan_meta.ScanSize(width_in=2.48, height_in=3.46, dpi=400.0),
        )

        def _boom(_b):
            raise AssertionError("a pixel pass ran despite a scan-metadata identity")

        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", _boom)
        disable_server_strategies()
        monkeypatch.setattr("app.cropper.tiered.tiered_crop", _boom)

        result = crop(image_bytes=image, precropped_bytes=None, crop_quality="fast")

        assert result.source == "scan_metadata"
        assert result.image_bytes == image
        assert result.returned_bytes_differ is False

    def test_it_reads_the_bytes_as_they_arrived(
        self, monkeypatch, stub_orient, stub_classify, disable_server_strategies
    ):
        """Resolution does not survive a re-encode, so the check has to see the
        original upload — not a candidate produced by some earlier stage."""
        stub_orient()
        stub_classify(_classify())
        image = _card_jpeg(size=(500, 700))
        seen: list[bytes] = []
        monkeypatch.setattr(
            "app.cropper.scan_meta.is_card_sized_scan",
            lambda b: seen.append(b) or None,
        )
        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", lambda _b: None)
        disable_server_strategies(tiered_crop=_card_jpeg(size=(400, 560)))

        crop(image_bytes=image, precropped_bytes=None, crop_quality="fast")

        assert seen == [image]

    def test_no_verdict_leaves_the_rest_of_the_cascade_untouched(
        self, monkeypatch, stub_orient, stub_classify, disable_server_strategies
    ):
        stub_orient()
        stub_classify(_classify())
        image = _card_jpeg(size=(1200, 1600))
        crop_bytes = _card_jpeg(size=(500, 700))
        monkeypatch.setattr("app.cropper.scan_meta.is_card_sized_scan", lambda _b: None)
        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", lambda _b: None)
        disable_server_strategies(tiered_crop=crop_bytes)

        result = crop(image_bytes=image, precropped_bytes=None, crop_quality="fast")

        assert result.source == "tiered"
        assert result.image_bytes == crop_bytes

    def test_strong_mode_skips_it(
        self, monkeypatch, stub_orient, stub_classify, disable_server_strategies
    ):
        """A human asking for a strong re-crop is explicitly overriding the
        "nothing to crop" judgement, so the metadata must not pre-empt them."""
        stub_orient()
        stub_classify(_classify())
        image = _card_jpeg(size=(500, 700))

        def _boom(_b):
            raise AssertionError("scan-metadata check ran in strong mode")

        monkeypatch.setattr("app.cropper.scan_meta.is_card_sized_scan", _boom)
        disable_server_strategies(tiered_crop=image)

        result = crop(image_bytes=image, precropped_bytes=None, crop_quality="strong")

        assert result.source == "tiered"

    def test_a_winning_precropped_upload_pre_empts_it(
        self, monkeypatch, stub_orient, stub_classify, disable_server_strategies
    ):
        """The client's own crop is still stage 1 — it is a stronger statement
        than "the frame is card-sized"."""
        stub_orient()
        stub_classify(_classify())

        def _boom(_b):
            raise AssertionError("scan-metadata check ran though precropped should win")

        monkeypatch.setattr("app.cropper.scan_meta.is_card_sized_scan", _boom)
        disable_server_strategies()

        result = crop(
            image_bytes=_card_jpeg(size=(1200, 1600)),
            precropped_bytes=_card_jpeg(size=(500, 700)),
            crop_quality="fast",
        )

        assert result.source == "precropped"

    def test_crop_only_mode_never_reaches_it(self, monkeypatch, stub_orient, stub_classify):
        """Crop-only has no original to measure; the check must not be
        consulted about the crop itself."""
        stub_orient()
        stub_classify(_classify())

        def _boom(_b):
            raise AssertionError("scan-metadata check ran in crop-only mode")

        monkeypatch.setattr("app.cropper.scan_meta.is_card_sized_scan", _boom)

        result = crop(image_bytes=None, precropped_bytes=_card_jpeg(size=(500, 700)))

        assert isinstance(result, CropResult)
        assert result.source == "precropped"

    def test_a_rejected_identity_falls_through_rather_than_failing(
        self, monkeypatch, stub_orient, stub_classify, disable_server_strategies
    ):
        """The metadata verdict still passes through `_try_stage`. If those
        gates reject it — the image is blank, Vision finds no text — the
        cascade must carry on, not surface a dead end."""
        stub_orient(_orient(text_count=0))
        stub_classify(_classify())
        image = _card_jpeg(size=(500, 700))
        monkeypatch.setattr(
            "app.cropper.scan_meta.is_card_sized_scan",
            lambda _b: scan_meta.ScanSize(width_in=2.48, height_in=3.46, dpi=400.0),
        )
        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", lambda _b: None)
        disable_server_strategies()

        result = crop(image_bytes=image, precropped_bytes=None, crop_quality="fast")

        assert result.source == "passthrough"

    def test_the_fast_role_settles_scans_without_escalating(
        self, monkeypatch, stub_orient, stub_classify, disable_server_strategies
    ):
        """The NEO-175 FAST service loads no model. The whole point of reading
        metadata is that it can now settle the scanner majority itself instead
        of declining and paying a round trip to the HEAVY service."""
        stub_orient()
        stub_classify(_classify())
        image = _card_jpeg(size=(500, 700))
        monkeypatch.setattr(
            "app.cropper.scan_meta.is_card_sized_scan",
            lambda _b: scan_meta.ScanSize(width_in=2.48, height_in=3.46, dpi=400.0),
        )
        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", lambda _b: None)
        disable_server_strategies()

        result = crop(
            image_bytes=image,
            precropped_bytes=None,
            crop_quality="fast",
            escalate_only=True,
        )

        assert isinstance(result, CropResult)
        assert result.source == "scan_metadata"

    def test_the_fast_role_still_declines_when_metadata_says_nothing(
        self, monkeypatch, stub_orient, stub_classify, disable_server_strategies
    ):
        stub_orient()
        stub_classify(_classify())
        monkeypatch.setattr("app.cropper.scan_meta.is_card_sized_scan", lambda _b: None)
        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", lambda _b: None)
        disable_server_strategies()

        result = crop(
            image_bytes=_card_jpeg(size=(1200, 1600)),
            precropped_bytes=None,
            crop_quality="fast",
            escalate_only=True,
        )

        assert isinstance(result, CropDeclined)
        assert result.reason == "fast_path_declined"


class TestCropQuality:
    """The NEO-173 fast/strong flag steers the image cascade only.

    "fast" runs `tiered.fast_tiered_crop` before the strategy loop; an identity
    result short-circuits WITHOUT the BiRefNet-bearing `tiered_crop`, and any
    other verdict escalates to the unchanged tiered-first loop. "strong" skips
    the fast pre-check entirely.
    """

    def test_fast_identity_short_circuits_before_the_birefnet_tiered_stage(
        self, monkeypatch, stub_orient, stub_classify, disable_server_strategies
    ):
        stub_orient()
        stub_classify(_classify())
        image = _card_jpeg(size=(500, 700))
        # Fast path accepts identity (returns the input untouched)…
        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", lambda b: b)

        # …so the BiRefNet-bearing tiered_crop must never be reached.
        def _boom(_b):
            raise AssertionError("tiered_crop ran despite a fast identity accept")

        disable_server_strategies()
        monkeypatch.setattr("app.cropper.tiered.tiered_crop", _boom)

        result = crop(image_bytes=image, precropped_bytes=None, crop_quality="fast")

        assert result.source == "tiered"
        assert result.returned_bytes_differ is False
        assert result.image_bytes == image

    def test_fast_escalates_to_the_full_tiered_stage_when_it_declines(
        self, monkeypatch, stub_orient, stub_classify, disable_server_strategies
    ):
        stub_orient()
        stub_classify(_classify())
        image = _card_jpeg(size=(1200, 1600))
        crop_bytes = _card_jpeg(size=(500, 700))
        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", lambda _b: None)
        disable_server_strategies(tiered_crop=crop_bytes)

        result = crop(image_bytes=image, precropped_bytes=None, crop_quality="fast")

        assert result.source == "tiered"
        assert result.image_bytes == crop_bytes
        assert result.returned_bytes_differ is True

    def test_strong_mode_never_runs_the_fast_path(
        self, monkeypatch, stub_orient, stub_classify, disable_server_strategies
    ):
        stub_orient()
        stub_classify(_classify())
        image = _card_jpeg(size=(500, 700))

        def _boom(_b):
            raise AssertionError("fast_tiered_crop ran in strong mode")

        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", _boom)
        disable_server_strategies(tiered_crop=image)  # strong tiered returns identity input

        result = crop(image_bytes=image, precropped_bytes=None, crop_quality="strong")

        assert result.source == "tiered"
        assert result.returned_bytes_differ is False

    def test_crop_quality_defaults_to_fast(
        self, monkeypatch, stub_orient, stub_classify, disable_server_strategies
    ):
        stub_orient()
        stub_classify(_classify())
        image = _card_jpeg(size=(1200, 1600))
        calls: list[bytes] = []
        monkeypatch.setattr(
            "app.cropper.tiered.fast_tiered_crop", lambda b: calls.append(b) or None
        )
        disable_server_strategies(tiered_crop=_card_jpeg(size=(500, 700)))

        crop(image_bytes=image, precropped_bytes=None)  # no crop_quality → default

        assert calls == [image]  # the fast path ran, so the default is "fast"

    def test_unknown_crop_quality_raises(self):
        with pytest.raises(ValueError, match="crop_quality"):
            crop(image_bytes=_card_jpeg(), precropped_bytes=None, crop_quality="ultra")

    def test_precropped_win_never_invokes_the_fast_path(
        self, monkeypatch, stub_orient, stub_classify, disable_server_strategies
    ):
        stub_orient()
        stub_classify(_classify())

        def _boom(_b):
            raise AssertionError("fast path ran though the precropped stage should win")

        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", _boom)
        disable_server_strategies()
        image = _card_jpeg(size=(1200, 1600))
        precropped = _card_jpeg(size=(500, 700))

        result = crop(image_bytes=image, precropped_bytes=precropped, crop_quality="fast")

        assert result.source == "precropped"


class TestEscalateOnly:
    """The NEO-175 FAST-role `escalate_only` no-fallthrough switch.

    escalate_only lets the FAST preprocess service run ONLY the classical fast
    path and decline (CropDeclined) at the exact seam where the cascade would
    otherwise fall through into the model-backed strategy loop — so it never
    loads or calls a local model. It wins on a classical identity accept and
    declines on everything else.
    """

    def test_fast_identity_accept_still_wins_under_escalate_only(
        self, monkeypatch, stub_orient, stub_classify, disable_server_strategies
    ):
        stub_orient()
        stub_classify(_classify())
        image = _card_jpeg(size=(500, 700))
        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", lambda b: b)
        disable_server_strategies()

        result = crop(
            image_bytes=image,
            precropped_bytes=None,
            crop_quality="fast",
            escalate_only=True,
        )

        assert isinstance(result, CropResult)
        assert result.source == "tiered"
        assert result.returned_bytes_differ is False
        assert result.image_bytes == image

    def test_declines_instead_of_running_the_model_backed_loop(
        self, monkeypatch, stub_orient, stub_classify
    ):
        stub_orient()
        stub_classify(_classify())
        image = _card_jpeg(size=(1200, 1600))
        # Fast path declines (escalate signal)…
        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", lambda _b: None)

        # …and NONE of the model-backed strategy loop may run.
        def _boom(_b):
            raise AssertionError("model-backed strategy ran under escalate_only")

        monkeypatch.setattr("app.cropper.tiered.tiered_crop", _boom)
        monkeypatch.setattr("app.cropper.sam.sam_crop", _boom)
        monkeypatch.setattr("app.cropper.haiku_bbox.haiku_bbox_crop", _boom)
        monkeypatch.setattr("app.cropper.pil_trim.trim_dark", _boom)
        monkeypatch.setattr("app.cropper.pil_trim.trim_light", _boom)

        result = crop(
            image_bytes=image,
            precropped_bytes=None,
            crop_quality="fast",
            escalate_only=True,
        )

        assert isinstance(result, CropDeclined)
        assert result.reason == "fast_path_declined"

    def test_strong_mode_under_escalate_only_declines_immediately(
        self, monkeypatch, stub_orient, stub_classify
    ):
        # crop_quality="strong" skips the classical fast block entirely, so an
        # escalate_only FAST service declines every strong request — the HEAVY
        # service owns the full cascade. No strategy (fast or heavy) may run.
        stub_orient()
        stub_classify(_classify())
        image = _card_jpeg(size=(1200, 1600))

        def _boom(_b):
            raise AssertionError("a strategy ran under escalate_only strong mode")

        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", _boom)
        monkeypatch.setattr("app.cropper.tiered.tiered_crop", _boom)
        monkeypatch.setattr("app.cropper.sam.sam_crop", _boom)

        result = crop(
            image_bytes=image,
            precropped_bytes=None,
            crop_quality="strong",
            escalate_only=True,
        )

        assert isinstance(result, CropDeclined)

    def test_default_escalate_only_false_runs_the_full_cascade(
        self, monkeypatch, stub_orient, stub_classify, disable_server_strategies
    ):
        # Without escalate_only, a fast decline falls through to the loop and
        # then passthrough — the HEAVY behaviour, unchanged and never declined.
        stub_orient()
        stub_classify(_classify())
        image = _card_jpeg(size=(1200, 1600))
        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", lambda _b: None)
        disable_server_strategies()

        result = crop(image_bytes=image, precropped_bytes=None, crop_quality="fast")

        assert isinstance(result, CropResult)
        assert result.source == "passthrough"

    def test_escalate_only_is_inert_when_precropped_wins(
        self, monkeypatch, stub_orient, stub_classify, disable_server_strategies
    ):
        # escalate_only governs only the image-only strategy loop; a winning
        # precropped stage returns its result regardless.
        stub_orient()
        stub_classify(_classify())
        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", lambda _b: None)
        disable_server_strategies()
        image = _card_jpeg(size=(1200, 1600))
        precropped = _card_jpeg(size=(500, 700))

        result = crop(
            image_bytes=image,
            precropped_bytes=precropped,
            crop_quality="fast",
            escalate_only=True,
        )

        assert isinstance(result, CropResult)
        assert result.source == "precropped"
