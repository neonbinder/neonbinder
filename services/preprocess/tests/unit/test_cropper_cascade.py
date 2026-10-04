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
from app.cropper.quad import QuadResult
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


class TestVisionDedupe:
    """NEO-315 D1: an identity candidate IS the image the baseline was taken
    on, so its orient is reused instead of a second, byte-identical Vision call.

    Every identity outcome hands back `image_bytes` itself (the same object):
    scan metadata, the classical fast path, and `tiered`'s identity guard in
    the strategy loop. Vision must run exactly once on each.
    """

    def test_scan_metadata_identity_calls_vision_once(
        self, stub_orient, stub_classify, monkeypatch
    ):
        monkeypatch.setattr(
            "app.cropper.scan_meta.is_card_sized_scan",
            lambda _b: scan_meta.ScanSize(width_in=2.48, height_in=3.46, dpi=400.0),
        )
        image = _card_jpeg()
        calls = stub_orient(_orient(text_count=12, rotation=90, confidence=0.8))
        stub_classify()

        result = crop(image_bytes=image, precropped_bytes=None)

        assert isinstance(result, CropResult)
        assert result.source == "scan_metadata"
        assert len(calls) == 1
        # The reused baseline is the result's orientation.
        assert result.orientation == _orient(text_count=12, rotation=90, confidence=0.8)

    def test_fast_classical_identity_calls_vision_once(
        self, stub_orient, stub_classify, monkeypatch
    ):
        monkeypatch.setattr("app.cropper.scan_meta.is_card_sized_scan", lambda _b: None)
        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", lambda b: b)
        image = _card_jpeg()
        calls = stub_orient()
        stub_classify()

        result = crop(image_bytes=image, precropped_bytes=None)

        assert isinstance(result, CropResult)
        assert result.source == "tiered"
        assert len(calls) == 1

    def test_heavy_tiered_identity_calls_vision_once(
        self, stub_orient, stub_classify, disable_server_strategies, monkeypatch
    ):
        disable_server_strategies()
        # `tiered_crop` returns its input untouched when the identity guard fires.
        monkeypatch.setattr("app.cropper.tiered.tiered_crop", lambda b: b)
        image = _card_jpeg()
        calls = stub_orient()
        stub_classify()

        result = crop(image_bytes=image, precropped_bytes=None, crop_quality="strong")

        assert isinstance(result, CropResult)
        assert result.source == "tiered"
        assert result.returned_bytes_differ is False
        assert len(calls) == 1

    def test_equal_but_distinct_bytes_still_call_vision(
        self, stub_orient, stub_classify, disable_server_strategies, monkeypatch
    ):
        # Reuse is keyed on object identity, never on content equality: a
        # strategy that re-encodes or copies has produced a different candidate
        # as far as the gate is concerned, so it gets its own orient.
        disable_server_strategies()
        image = _card_jpeg()
        monkeypatch.setattr("app.cropper.tiered.tiered_crop", lambda b: bytes(bytearray(b)))
        calls = stub_orient()
        stub_classify()

        result = crop(image_bytes=image, precropped_bytes=None, crop_quality="strong")

        assert isinstance(result, CropResult)
        assert len(calls) == 2

    def test_a_real_crop_gets_its_own_orient(
        self, stub_orient_by_call, stub_classify, disable_server_strategies
    ):
        crop_bytes = _card_jpeg(size=(400, 560))
        disable_server_strategies(trim_dark=crop_bytes)
        calls = stub_orient_by_call(_orient(text_count=10), _orient(text_count=9, rotation=180))
        stub_classify()

        result = crop(image_bytes=_card_jpeg(), precropped_bytes=None, crop_quality="strong")

        assert isinstance(result, CropResult)
        assert result.source == "pil_trim_dark"
        assert calls[1] is crop_bytes
        assert result.orientation.rotation_degrees == 180


class TestSuppliedBaseline:
    """NEO-315 D4: a caller-supplied whole-image baseline replaces the
    up-front Vision call everywhere the computed one was used."""

    def test_supplied_baseline_skips_vision_on_an_identity_win(
        self, stub_orient, stub_classify, monkeypatch
    ):
        monkeypatch.setattr("app.cropper.scan_meta.is_card_sized_scan", lambda _b: None)
        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", lambda b: b)
        calls = stub_orient()
        stub_classify()
        supplied = _orient(text_count=7, rotation=270, confidence=0.6)

        result = crop(image_bytes=_card_jpeg(), precropped_bytes=None, baseline=supplied)

        assert isinstance(result, CropResult)
        assert calls == []
        assert result.orientation == supplied

    def test_supplied_baseline_sets_the_text_threshold(
        self, stub_orient, stub_classify, disable_server_strategies
    ):
        # Baseline 20 words → threshold 16. A crop whose own orient finds 10
        # words is a regression and must be rejected, landing on passthrough.
        disable_server_strategies(trim_dark=_card_jpeg(size=(400, 560)))
        calls = stub_orient(_orient(text_count=10))
        stub_classify()
        supplied = _orient(text_count=20)

        result = crop(
            image_bytes=_card_jpeg(),
            precropped_bytes=None,
            crop_quality="strong",
            baseline=supplied,
        )

        assert isinstance(result, CropResult)
        assert result.source == "passthrough"
        assert result.orientation == supplied
        # Only the crop candidate was sent to Vision; never the original.
        assert len(calls) == 1

    def test_declined_carries_the_baseline(self, stub_orient, monkeypatch):
        monkeypatch.setattr("app.cropper.scan_meta.is_card_sized_scan", lambda _b: None)
        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", lambda _b: None)
        stub_orient(_orient(text_count=33, rotation=90, confidence=0.75))

        result = crop(image_bytes=_card_jpeg(), precropped_bytes=None, escalate_only=True)

        assert isinstance(result, CropDeclined)
        assert result.baseline == _orient(text_count=33, rotation=90, confidence=0.75)


class TestRotatedBytes:
    """NEO-315 D3: the winner's rotated bytes (what classify saw) ride on the
    result so /process-entry never rotates the winner a second time."""

    def test_zero_rotation_is_the_same_object(self, stub_orient, stub_classify, monkeypatch):
        monkeypatch.setattr("app.cropper.scan_meta.is_card_sized_scan", lambda _b: None)
        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", lambda b: b)
        stub_orient(_orient(rotation=0))
        stub_classify()
        image = _card_jpeg()

        result = crop(image_bytes=image, precropped_bytes=None)

        assert isinstance(result, CropResult)
        assert result.rotated_bytes is image

    def test_rotated_bytes_are_exactly_what_classify_saw(
        self, stub_orient, stub_classify, monkeypatch
    ):
        from app.cropper._utils import rotate_image_bytes

        monkeypatch.setattr("app.cropper.scan_meta.is_card_sized_scan", lambda _b: None)
        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", lambda b: b)
        stub_orient(_orient(rotation=90))
        classify_calls = stub_classify()
        image = _card_jpeg()

        result = crop(image_bytes=image, precropped_bytes=None)

        assert isinstance(result, CropResult)
        assert result.rotated_bytes == classify_calls[0]
        assert result.rotated_bytes == rotate_image_bytes(image, 90)

    def test_passthrough_carries_rotated_bytes(
        self, stub_orient, stub_classify, disable_server_strategies
    ):
        from app.cropper._utils import rotate_image_bytes

        disable_server_strategies()
        stub_orient(_orient(rotation=180))
        stub_classify()
        image = _card_jpeg()

        result = crop(image_bytes=image, precropped_bytes=None, crop_quality="strong")

        assert isinstance(result, CropResult)
        assert result.source == "passthrough"
        assert result.rotated_bytes == rotate_image_bytes(image, 180)


class TestCascadeTimings:
    """NEO-315: crop() accumulates into the caller's per-request Timings."""

    def test_counts_vision_calls_and_records_the_haiku_signals(
        self, stub_orient, stub_classify, disable_server_strategies
    ):
        from app.timing import Timings

        disable_server_strategies(haiku_bbox_crop=_card_jpeg(size=(400, 560)))
        stub_orient()
        stub_classify()
        timings = Timings()

        result = crop(
            image_bytes=_card_jpeg(), precropped_bytes=None, crop_quality="strong", timings=timings
        )

        assert isinstance(result, CropResult)
        assert result.source == "haiku_bbox"
        # Baseline + the haiku crop's own orient.
        assert timings.vision_calls == 2
        assert timings.haiku_bbox_reached is True
        assert timings.haiku_bbox_won is True

    def test_haiku_not_reached_when_an_earlier_stage_wins(
        self, stub_orient, stub_classify, disable_server_strategies
    ):
        from app.timing import Timings

        disable_server_strategies(trim_dark=_card_jpeg(size=(400, 560)))
        stub_orient()
        stub_classify()
        timings = Timings()

        crop(
            image_bytes=_card_jpeg(), precropped_bytes=None, crop_quality="strong", timings=timings
        )

        assert timings.haiku_bbox_reached is False
        assert timings.haiku_bbox_won is False

    def test_classify_retry_is_recorded(self, stub_orient, disable_server_strategies, monkeypatch):
        import dataclasses

        from app.timing import Timings

        disable_server_strategies()
        stub_orient()
        monkeypatch.setattr(
            cropper, "classify_card", lambda _b: dataclasses.replace(_classify(), retried=True)
        )
        timings = Timings()

        crop(
            image_bytes=_card_jpeg(), precropped_bytes=None, crop_quality="strong", timings=timings
        )

        assert timings.classify_retried is True

    def test_birefnet_share_of_tiered_is_not_counted_as_classical(
        self, stub_orient, stub_classify, disable_server_strategies, monkeypatch
    ):
        import time

        from app.timing import Timings, measure_current

        disable_server_strategies()

        def _tiered(_b):
            time.sleep(0.01)  # classical work
            with measure_current("birefnet_ms"):
                time.sleep(0.05)  # BiRefNet inference
            return None

        monkeypatch.setattr("app.cropper.tiered.tiered_crop", _tiered)
        stub_orient()
        stub_classify()
        timings = Timings()

        crop(
            image_bytes=_card_jpeg(), precropped_bytes=None, crop_quality="strong", timings=timings
        )

        assert timings.birefnet_ms >= 50
        assert 10 <= timings.classical_ms < 50


class TestSkipFastPath:
    """NEO-315: `skip_fast_path` bypasses every fast-path stage (both identity
    checks and the NEO-320 quad crop); default unchanged."""

    def test_skip_bypasses_both_stages_and_runs_the_loop(
        self, stub_orient, stub_classify, disable_server_strategies, monkeypatch
    ):
        def _boom(_b):
            raise AssertionError("fast-path stage ran")

        monkeypatch.setattr("app.cropper.scan_meta.is_card_sized_scan", _boom)
        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", _boom)
        monkeypatch.setattr("app.cropper.quad.quad_crop", _boom)
        disable_server_strategies(trim_dark=_card_jpeg(size=(400, 560)))
        stub_orient()
        stub_classify()

        result = crop(
            image_bytes=_card_jpeg(),
            precropped_bytes=None,
            baseline=_orient(),
            skip_fast_path=True,
        )

        assert isinstance(result, CropResult)
        assert result.source == "pil_trim_dark"

    def test_default_still_runs_the_fast_path(self, stub_orient, stub_classify, monkeypatch):
        calls: list[str] = []
        monkeypatch.setattr(
            "app.cropper.scan_meta.is_card_sized_scan",
            lambda _b: calls.append("scan") or None,
        )
        monkeypatch.setattr(
            "app.cropper.tiered.fast_tiered_crop", lambda b: calls.append("fast") or b
        )
        stub_orient()
        stub_classify()

        result = crop(image_bytes=_card_jpeg(), precropped_bytes=None, baseline=_orient())

        assert calls == ["scan", "fast"]
        assert isinstance(result, CropResult) and result.source == "tiered"


class TestQuadStage:
    """NEO-320: the FAST role's quad crop.

    It runs after BOTH identity checks (a frame that already is the card must
    never be offered to a corner detector), on every frame they did not
    accept, and before the escalate_only decline. Its crop is a new image and
    still clears the uniform `_try_stage` gates; when it declines, or its crop
    fails a gate, the FAST role declines exactly as before, carrying the
    baseline for HEAVY.
    """

    CROP = _card_jpeg(size=(500, 700))

    @staticmethod
    def _forbid_models(monkeypatch) -> None:
        def _boom(_b):
            raise AssertionError("model-backed strategy ran under escalate_only")

        monkeypatch.setattr("app.cropper.tiered.tiered_crop", _boom)
        monkeypatch.setattr("app.cropper.sam.sam_crop", _boom)
        monkeypatch.setattr("app.cropper.haiku_bbox.haiku_bbox_crop", _boom)
        monkeypatch.setattr("app.cropper.pil_trim.trim_dark", _boom)
        monkeypatch.setattr("app.cropper.pil_trim.trim_light", _boom)

    def _install(self, monkeypatch, quad_result: QuadResult | None) -> list[str]:
        calls: list[str] = []
        monkeypatch.setattr(
            "app.cropper.scan_meta.is_card_sized_scan", lambda _b: calls.append("scan") or None
        )
        monkeypatch.setattr(
            "app.cropper.tiered.fast_tiered_crop", lambda _b: calls.append("fast") or None
        )

        def _quad(_b):
            calls.append("quad")
            if quad_result is None:
                raise AssertionError("quad_crop ran")
            return quad_result

        monkeypatch.setattr("app.cropper.quad.quad_crop", _quad)
        return calls

    def test_runs_after_both_identity_checks_and_wins_as_quad(
        self, monkeypatch, stub_orient, stub_classify
    ):
        stub_orient()
        stub_classify()
        self._forbid_models(monkeypatch)
        calls = self._install(monkeypatch, QuadResult(self.CROP, "ok"))

        result = crop(
            image_bytes=_card_jpeg(size=(1200, 1600)),
            precropped_bytes=None,
            escalate_only=True,
        )

        assert calls == ["scan", "fast", "quad"]
        assert isinstance(result, CropResult)
        assert result.source == "quad"
        assert result.image_bytes == self.CROP
        assert result.returned_bytes_differ is True

    def test_a_quad_win_costs_exactly_two_vision_calls(
        self, monkeypatch, stub_orient, stub_classify
    ):
        """The baseline, then the quad crop's own gate — nothing else."""
        from app.timing import Timings

        calls = stub_orient()
        stub_classify()
        self._forbid_models(monkeypatch)
        self._install(monkeypatch, QuadResult(self.CROP, "ok"))
        image = _card_jpeg(size=(1200, 1600))
        timings = Timings()

        result = crop(image_bytes=image, precropped_bytes=None, escalate_only=True, timings=timings)

        assert result.source == "quad"
        assert timings.vision_calls == 2
        assert calls == [image, self.CROP]

    def test_a_vision_failure_on_the_quad_crop_declines_with_the_baseline(
        self, monkeypatch, stub_classify
    ):
        """The quad crop's gate is the one Vision call a FAST entry adds; if it
        raises, the entry escalates with its baseline instead of 502ing."""
        baseline = _orient(text_count=17, rotation=90, confidence=0.8)
        seen: list[bytes] = []

        def _orient_then_fail(b: bytes) -> OrientationResult:
            seen.append(b)
            if len(seen) == 1:
                return baseline
            raise RuntimeError("vision unavailable")

        monkeypatch.setattr(cropper, "detect_orientation", _orient_then_fail)
        stub_classify()
        self._forbid_models(monkeypatch)
        self._install(monkeypatch, QuadResult(self.CROP, "ok"))

        result = crop(image_bytes=_card_jpeg(), precropped_bytes=None, escalate_only=True)

        assert len(seen) == 2, "the quad crop's gate did call Vision"
        assert isinstance(result, CropDeclined)
        assert result.reason == "fast_path_declined"
        assert result.baseline == baseline

    def test_an_identity_win_never_reaches_the_quad(self, monkeypatch, stub_orient, stub_classify):
        stub_orient()
        stub_classify()
        self._install(monkeypatch, None)
        monkeypatch.setattr("app.cropper.tiered.fast_tiered_crop", lambda b: b)

        result = crop(image_bytes=_card_jpeg(), precropped_bytes=None, escalate_only=True)

        assert isinstance(result, CropResult)
        assert result.source == "tiered"

    def test_a_scan_metadata_win_never_reaches_the_quad(
        self, monkeypatch, stub_orient, stub_classify
    ):
        stub_orient()
        stub_classify()
        self._install(monkeypatch, None)
        monkeypatch.setattr("app.cropper.scan_meta.is_card_sized_scan", lambda _b: object())

        result = crop(image_bytes=_card_jpeg(), precropped_bytes=None, escalate_only=True)

        assert isinstance(result, CropResult)
        assert result.source == "scan_metadata"

    @pytest.mark.parametrize("reason", ["shaved", "loose", "multi_card", "no_quad"])
    def test_a_quad_decline_still_declines_with_the_baseline(
        self, monkeypatch, stub_orient, stub_classify, reason
    ):
        baseline = _orient(text_count=21, rotation=180, confidence=0.6)
        stub_orient(baseline)
        stub_classify()
        self._forbid_models(monkeypatch)
        calls = self._install(monkeypatch, QuadResult(None, reason))

        result = crop(image_bytes=_card_jpeg(), precropped_bytes=None, escalate_only=True)

        assert calls == ["scan", "fast", "quad"]
        assert isinstance(result, CropDeclined)
        assert result.reason == "fast_path_declined"
        assert result.baseline == baseline

    def test_a_quad_crop_below_the_text_gate_declines_with_the_baseline(
        self, monkeypatch, stub_orient_by_call, stub_classify
    ):
        # Baseline sees 20 tokens; the quad crop only 3 — a wrong-region crop.
        calls = stub_orient_by_call(_orient(text_count=20), _orient(text_count=3))
        stub_classify()
        self._forbid_models(monkeypatch)
        self._install(monkeypatch, QuadResult(self.CROP, "ok"))

        result = crop(image_bytes=_card_jpeg(), precropped_bytes=None, escalate_only=True)

        assert isinstance(result, CropDeclined)
        assert result.baseline == _orient(text_count=20)
        assert calls[1] == self.CROP, "the quad crop gets its own orient"

    def test_a_quad_crop_failing_the_validator_declines(
        self, monkeypatch, stub_orient, stub_classify
    ):
        stub_orient()
        stub_classify()
        self._forbid_models(monkeypatch)
        self._install(monkeypatch, QuadResult(_tiny_jpeg(), "ok"))

        result = crop(image_bytes=_card_jpeg(), precropped_bytes=None, escalate_only=True)

        assert isinstance(result, CropDeclined)

    def test_without_escalate_only_a_decline_falls_through_to_the_strategies(
        self, monkeypatch, stub_orient, stub_classify, disable_server_strategies
    ):
        stub_orient()
        stub_classify()
        disable_server_strategies(trim_dark=_card_jpeg(size=(400, 560)))
        calls = self._install(monkeypatch, QuadResult(None, "shaved"))

        result = crop(image_bytes=_card_jpeg(), precropped_bytes=None)

        assert calls == ["scan", "fast", "quad"]
        assert isinstance(result, CropResult)
        assert result.source == "pil_trim_dark"

    def test_strong_mode_never_runs_the_quad(self, monkeypatch, stub_orient, stub_classify):
        stub_orient()
        stub_classify()
        self._install(monkeypatch, None)

        result = crop(
            image_bytes=_card_jpeg(),
            precropped_bytes=None,
            crop_quality="strong",
            escalate_only=True,
        )

        assert isinstance(result, CropDeclined)

    def test_quad_time_is_booked_to_quad_ms(self, monkeypatch, stub_orient, stub_classify):
        import time

        from app.timing import Timings

        stub_orient()
        stub_classify()
        self._forbid_models(monkeypatch)
        self._install(monkeypatch, QuadResult(None, "no_quad"))
        real = cropper.quad.quad_crop

        def _slow(b):
            time.sleep(0.03)
            return real(b)

        monkeypatch.setattr("app.cropper.quad.quad_crop", _slow)
        timings = Timings()

        crop(image_bytes=_card_jpeg(), precropped_bytes=None, escalate_only=True, timings=timings)

        assert timings.quad_ms >= 30
        assert timings.classical_ms < 30
