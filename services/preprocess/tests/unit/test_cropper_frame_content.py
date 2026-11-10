"""Unit tests for the NEO-399 FAST frame-content identity stage.

`app.cropper.frame_content` settles a tightly cropped card scan that carries
no trustworthy resolution on the FAST role, instead of escalating it to the
HEAVY role's BiRefNet pass. It runs after the classical identity check
(verdict `weak`) and the quad crop (declined `no_quad` or `weak_edges`), and
it accepts only when the pixels say the frame already IS the card:

- the frame is card-aspect;
- each side's outer band, past a thin sliver, is mostly one colour (`ring`);
- printed content starts within a small cap of every edge (`no_content` /
  `inset`), so at most a few px of extra same-colour margin can ride along;
- no faint line runs parallel to an edge inside that margin (`edge_in_margin`),
  which is what a shadow or the card's own cut edge on a matched bed leaves.

Everything here is pixel-only and drives the real cascade (`crop()` with
`escalate_only=True`, the FAST role's posture): Vision and classify are
faked as in test_cropper_cascade.py, and BiRefNet is forbidden outright.

Real pixels come from the intake E2E scans in
`apps/web/playwright/fixtures/intake/` (72 dpi, no usable density) and the
placeholder sets in `apps/web/public/placeholder-fixtures*`. A test that
needs a set skips cleanly when the checkout does not carry it.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

import cv2
import numpy as np
import pytest

from app import cropper
from app.classify import ClassifyResult
from app.cropper import CropDeclined, CropResult, crop, frame_content, quad, tiered
from app.orient import OrientationResult
from app.timing import Timings

REPO_ROOT = Path(__file__).resolve().parents[4]
INTAKE_DIR = REPO_ROOT / "apps" / "web" / "playwright" / "fixtures" / "intake"
PLACEHOLDER_DIR = REPO_ROOT / "apps" / "web" / "public"

SOURCE = "frame_content"

# Intake scans the classical check settles itself (verdict `frame`), and the
# ones it calls `weak` that this stage must settle.
CLASSICAL_FRAME_SCANS = ("01-mcfadden-front", "03-bowe-front", "07-bowe-again-front")
FRAME_CONTENT_SCANS = (
    "02-mcfadden-back",
    "04-bowe-back",
    "05-bell-front",
    "06-bell-back",
    "08-bowe-again-back",
)

# Jason's bound (NEO-399): any extra same-colour margin the rule accepts
# beyond the card's own border is at most a few px, about 4.
EXTRA_MARGIN_BOUND_PX = 4

_DECLINE_LOG = re.compile(r"fast: frame content declined reason=(\w+)")


# ── Fixture loading ──────────────────────────────────────────────────────


def _intake_bytes(name: str) -> bytes:
    path = INTAKE_DIR / f"{name}.jpg"
    if not path.exists():
        pytest.skip(f"intake fixture not in this checkout: {path}")
    return path.read_bytes()


def _placeholder_files(variant: str) -> list[Path]:
    folder = PLACEHOLDER_DIR / variant
    files = sorted(folder.glob("0*.jpg"))
    if not files:
        pytest.skip(f"placeholder set not in this checkout: {folder}")
    return files


def _decode(data: bytes) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    assert img is not None
    return img


def _jpeg(img: np.ndarray, quality: int = 92) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    assert ok
    return bytes(buf)


# ── Scene builders (real pixels from intake 02) ──────────────────────────


def _border_colour(img: np.ndarray) -> np.ndarray:
    """Median BGR of the card's own border, skipping the scanner's sliver."""
    h, w = img.shape[:2]
    a, b = 3, 12
    band = np.concatenate(
        [
            img[a:b, :].reshape(-1, 3),
            img[h - b : h - a, :].reshape(-1, 3),
            img[:, a:b].reshape(-1, 3),
            img[:, w - b : w - a].reshape(-1, 3),
        ]
    )
    return np.median(band, axis=0)


def _bed(h: int, w: int, colour: np.ndarray, *, noise: float = 1.5, seed: int = 7) -> np.ndarray:
    """A scanner bed matched to `colour`, with sensor-level noise."""
    rng = np.random.default_rng(seed)
    bed = np.broadcast_to(colour, (h, w, 3)).astype(np.float32)
    bed = bed + rng.normal(0.0, noise, (h, w, 1))
    return np.clip(bed, 0, 255).astype(np.uint8)


def _pad_on_matched_bed(
    img: np.ndarray, *, mx: int, my: int, shadow: int = 0
) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    """Lay `img` on a bed of its own border colour with margins mx/my.

    `shadow` > 0 draws a 1 px line `shadow` levels darker than the bed just
    outside the card's cut edge, all the way round — the faint parallel line
    a scanner shadow or a slightly lifted card leaves inside the margin.
    """
    h, w = img.shape[:2]
    out = _bed(h + 2 * my, w + 2 * mx, _border_colour(img))
    out[my : my + h, mx : mx + w] = img
    box = (mx, my, mx + w, my + h)
    if shadow:
        colour = np.clip(_border_colour(img) - shadow, 0, 255).astype(np.uint8)
        out[my - 1, mx - 1 : mx + w + 1] = colour
        out[my + h, mx - 1 : mx + w + 1] = colour
        out[my - 1 : my + h + 1, mx - 1] = colour
        out[my - 1 : my + h + 1, mx + w] = colour
    return out, box


def _pad_frac(img: np.ndarray, frac: float, *, shadow: int = 0) -> bytes:
    """Pad proportionally (frac of each dimension) so the frame keeps the
    card's aspect and stays a card-aspect frame for the classical check."""
    h, w = img.shape[:2]
    out, _ = _pad_on_matched_bed(img, mx=round(w * frac), my=round(h * frac), shadow=shadow)
    return _jpeg(out)


def _wood(h: int, w: int, seed: int = 3) -> np.ndarray:
    """A wood-grain-ish texture: banded sinusoid plus noise, warm hue."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    grain = np.sin(xx * 0.09 + 6.0 * np.sin(yy * 0.011)) * 22.0
    base = 120.0 + grain + rng.normal(0.0, 9.0, (h, w))
    b = np.clip(base * 0.45, 0, 255)
    g = np.clip(base * 0.75, 0, 255)
    r = np.clip(base * 1.05, 0, 255)
    return np.dstack([b, g, r]).astype(np.uint8)


# ── Cascade harness ──────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _forbid_birefnet(monkeypatch):
    """The FAST role never loads a model. Any attempt fails the test."""

    def _boom(*_args, **_kwargs):
        raise AssertionError("the FAST frame-content path must not touch BiRefNet")

    monkeypatch.setattr(tiered, "birefnet_mask", _boom)
    monkeypatch.setattr(tiered, "_get_session", _boom)
    for target in (
        "app.cropper.tiered.tiered_crop",
        "app.cropper.sam.sam_crop",
        "app.cropper.haiku_bbox.haiku_bbox_crop",
        "app.cropper.pil_trim.trim_dark",
        "app.cropper.pil_trim.trim_light",
    ):
        monkeypatch.setattr(target, _boom)


@pytest.fixture
def vision(monkeypatch) -> list[bytes]:
    """Fake Vision + classify. Returns the list of bytes sent to Vision."""
    calls: list[bytes] = []

    def _orient(b: bytes) -> OrientationResult:
        calls.append(b)
        return OrientationResult(rotation_degrees=0, confidence=1.0, text_count=12)

    def _classify(_b: bytes) -> ClassifyResult:
        return ClassifyResult(
            players=["Somebody"], team="Team", card_number="1", side="back", raw_text="{}"
        )

    monkeypatch.setattr(cropper, "detect_orientation", _orient)
    monkeypatch.setattr(cropper, "classify_card", _classify)
    return calls


def _run(data: bytes, caplog, timings: Timings | None = None):
    """FAST-role crop of `data`; returns (result, frame-content decline reason)."""
    caplog.clear()
    with caplog.at_level(logging.INFO):
        result = crop(
            image_bytes=data,
            precropped_bytes=None,
            escalate_only=True,
            timings=timings or Timings(),
        )
    reasons = [m.group(1) for r in caplog.records if (m := _DECLINE_LOG.search(r.getMessage()))]
    return result, (reasons[-1] if reasons else None)


def _accepted(result) -> bool:
    return isinstance(result, CropResult) and result.source == SOURCE


# ── Positives: the real intake scans ─────────────────────────────────────


class TestIntakeScansSettleOnFast:
    @pytest.mark.parametrize("name", CLASSICAL_FRAME_SCANS)
    def test_frame_fill_scans_still_settle_on_the_classical_check(self, name, vision, caplog):
        data = _intake_bytes(name)

        result, _ = _run(data, caplog)

        assert isinstance(result, CropResult), result
        assert result.source == "tiered"
        assert result.image_bytes is data

    @pytest.mark.parametrize("name", FRAME_CONTENT_SCANS)
    def test_weak_scans_settle_as_frame_content_identity(self, name, vision, caplog):
        data = _intake_bytes(name)
        timings = Timings()

        result, reason = _run(data, caplog, timings)

        assert isinstance(result, CropResult), f"declined reason={reason}"
        assert result.source == SOURCE
        assert result.image_bytes is data, "identity: the upload itself, not a re-encode"
        assert result.returned_bytes_differ is False
        assert vision == [data], "only the baseline Vision call"
        assert timings.vision_calls == 1

    @pytest.mark.parametrize("name", FRAME_CONTENT_SCANS)
    def test_weak_scans_reach_the_stage_on_the_contracted_verdicts(self, name):
        """Guards the fixture assumptions: classical `weak`, quad no_quad/weak_edges."""
        data = _intake_bytes(name)
        _bytes, verdict = tiered.fast_tiered_verdict(data)
        assert _bytes is None
        assert verdict == "weak"
        assert quad.quad_crop(data).reason in {"no_quad", "weak_edges"}


# ── Real-pixel negatives built from intake 02 ────────────────────────────


class TestMatchedBedMargins:
    """Intake 02 laid on a bed matched to its own border colour.

    This is the hard case the rule exists to bound: the card's cut edge is
    nearly invisible, so only the margin depth and any faint line inside it
    tell a bare card from a card sitting on a bed.
    """

    @pytest.mark.parametrize("frac", [0.02, 0.04, 0.08])
    def test_a_faint_shadow_line_in_the_margin_is_never_accepted(self, frac, vision, caplog):
        img = _decode(_intake_bytes("02-mcfadden-back"))

        result, _ = _run(_pad_frac(img, frac, shadow=14), caplog)

        # At 2% the shadow ring reads as a frame-filling component, so the
        # classical check (not this stage) answers; this stage must simply
        # never be the one that accepts it.
        assert not _accepted(result)

    @pytest.mark.parametrize(
        ("frac", "reasons"),
        [(0.04, {"edge_in_margin"}), (0.08, {"inset", "edge_in_margin"})],
    )
    def test_a_faint_shadow_line_in_the_margin_declines_with_a_named_reason(
        self, frac, reasons, vision, caplog
    ):
        img = _decode(_intake_bytes("02-mcfadden-back"))

        result, reason = _run(_pad_frac(img, frac, shadow=14), caplog)

        assert isinstance(result, CropDeclined)
        assert reason in reasons

    def test_a_deep_margin_with_no_line_declines(self, vision, caplog):
        img = _decode(_intake_bytes("02-mcfadden-back"))

        result, reason = _run(_pad_frac(img, 0.08), caplog)

        assert not _accepted(result)
        assert isinstance(result, CropDeclined)
        assert reason in {"inset", "no_content", "edge_in_margin"}

    @pytest.mark.parametrize("margin_px", [1, 2, 3, 4, 6, 10, 20, 40])
    def test_bounded_hole_uniform_margin_with_no_line_accepts_only_within_the_bound(
        self, margin_px, vision, caplog
    ):
        """The documented hole: a matched bed with no shadow and a margin so
        shallow the pixels cannot tell it from the card's own border. The rule
        may accept it, but only while the extra margin is within the bound;
        anything deeper must decline."""
        img = _decode(_intake_bytes("02-mcfadden-back"))
        out, _ = _pad_on_matched_bed(img, mx=margin_px, my=margin_px)

        result, reason = _run(_jpeg(out), caplog)

        self._assert_within_bound(result, reason, margin_px)

    @pytest.mark.parametrize("frac", [0.002, 0.004, 0.01, 0.02, 0.04])
    def test_bounded_hole_aspect_preserving_margin_with_no_line_accepts_only_within_the_bound(
        self, frac, vision, caplog
    ):
        """The same hole with the margin scaled per axis, so the frame keeps
        the card's own aspect and no aspect check can see the extra margin."""
        img = _decode(_intake_bytes("02-mcfadden-back"))
        h, w = img.shape[:2]
        mx, my = round(w * frac), round(h * frac)
        out, _ = _pad_on_matched_bed(img, mx=mx, my=my)

        result, reason = _run(_jpeg(out), caplog)

        self._assert_within_bound(result, reason, min(mx, my))

    @staticmethod
    def _assert_within_bound(result, reason, margin_px: int) -> None:
        if _accepted(result):
            assert margin_px <= EXTRA_MARGIN_BOUND_PX, (
                f"accepted {margin_px}px of extra margin; bound is {EXTRA_MARGIN_BOUND_PX}px"
            )
        else:
            assert isinstance(result, CropDeclined), reason


# ── Synthetic negatives ──────────────────────────────────────────────────


def _scene_wood_bed() -> bytes:
    img = _decode(_intake_bytes("02-mcfadden-back"))
    h, w = img.shape[:2]
    mx, my = round(w * 0.04), round(h * 0.04)
    bed = _wood(h + 2 * my, w + 2 * mx)
    bed[my : my + h, mx : mx + w] = img
    return _jpeg(bed)


def _scene_noise_bed() -> bytes:
    img = _decode(_intake_bytes("02-mcfadden-back"))
    h, w = img.shape[:2]
    mx, my = round(w * 0.03), round(h * 0.03)
    rng = np.random.default_rng(11)
    bed = rng.integers(0, 256, (h + 2 * my, w + 2 * mx, 3), dtype=np.uint8)
    bed[my : my + h, mx : mx + w] = img
    return _jpeg(bed)


def _scene_card_matching_mat() -> bytes:
    # 700x980 card-aspect frame: a white card whose printed panel sits well
    # inside, on a white mat of the same colour, so the card's own edge is
    # invisible and only the depth of the margin gives it away.
    frame = np.full((980, 700, 3), 246, np.uint8)
    x0, y0, x1, y1 = 70, 98, 630, 882  # the card, 10% in from every side
    cv2.rectangle(frame, (x0 + 30, y0 + 30), (x1 - 30, y1 - 30), (60, 90, 170), -1)
    cv2.putText(frame, "No. 42", (x0 + 60, y0 + 120), cv2.FONT_HERSHEY_SIMPLEX, 2, (250,) * 3, 4)
    return _jpeg(frame)


def _scene_corner_placement() -> bytes:
    img = _decode(_intake_bytes("02-mcfadden-back"))
    h, w = img.shape[:2]
    small = cv2.resize(img, (round(w * 0.7), round(h * 0.7)), interpolation=cv2.INTER_AREA)
    frame = _bed(h, w, _border_colour(img))
    frame[0 : small.shape[0], 0 : small.shape[1]] = small
    return _jpeg(frame)


def _scene_blank_frame() -> bytes:
    return _jpeg(_bed(1392, 992, np.array([238.0, 240.0, 241.0])))


def _scene_non_card_aspect() -> bytes:
    img = _decode(_intake_bytes("02-mcfadden-back"))
    h, w = img.shape[:2]
    side = max(h, w)
    out, _ = _pad_on_matched_bed(img, mx=(side - w) // 2, my=(side - h) // 2)
    return _jpeg(out)


SYNTHETIC_NEGATIVES = {
    "wood_texture_bed": _scene_wood_bed,
    "noise_texture_bed": _scene_noise_bed,
    "card_matching_mat": _scene_card_matching_mat,
    "corner_placement": _scene_corner_placement,
    "blank_frame": _scene_blank_frame,
    "non_card_aspect_frame": _scene_non_card_aspect,
}


class TestNeverAccepted:
    @pytest.mark.parametrize("scene", sorted(SYNTHETIC_NEGATIVES))
    def test_the_cascade_never_settles_it_as_frame_content(self, scene, vision, caplog):
        result, _ = _run(SYNTHETIC_NEGATIVES[scene](), caplog)

        assert not _accepted(result)

    @pytest.mark.parametrize("scene", sorted(SYNTHETIC_NEGATIVES))
    def test_the_rule_itself_declines_it_even_when_every_precondition_holds(self, scene):
        """Hand the rule the verdicts it follows (`weak`, `no_quad`) so only
        its own pixel checks stand between the scene and an accept: the
        validator and the quad cannot be what keeps these out."""
        verdict = frame_content.frame_content_identity(
            SYNTHETIC_NEGATIVES[scene](), classical_reason="weak", quad_reason="no_quad"
        )

        assert verdict.accepted is False, verdict.diagnostics


# ── Placeholder sets: the stage stays out of the way ─────────────────────


@pytest.fixture
def stage_spy(monkeypatch) -> list[bytes]:
    """Record every call into the frame-content stage, delegating to it."""
    calls: list[bytes] = []
    real = frame_content.frame_content_identity

    def _spy(image_bytes, *args, **kwargs):
        calls.append(image_bytes)
        return real(image_bytes, *args, **kwargs)

    monkeypatch.setattr(frame_content, "frame_content_identity", _spy)
    return calls


class TestPlaceholderSets:
    def test_cornered_cards_decline_at_the_quad_and_never_consult_the_rule(
        self, vision, caplog, stage_spy
    ):
        for path in _placeholder_files("placeholder-fixtures-corner"):
            data = path.read_bytes()
            assert quad.quad_crop(data).reason == "frame_edge", path.name

            result, _ = _run(data, caplog)

            assert isinstance(result, CropDeclined), path.name
        assert stage_spy == []

    def test_inset_cards_are_cropped_by_the_quad(self, vision, caplog, stage_spy):
        for path in _placeholder_files("placeholder-fixtures"):
            result, _ = _run(path.read_bytes(), caplog)

            assert isinstance(result, CropResult), path.name
            assert result.source == "quad", path.name
        assert stage_spy == []

    def test_full_bleed_cards_settle_on_the_classical_frame_check(self, vision, caplog, stage_spy):
        for path in _placeholder_files("placeholder-fixtures-fullbleed"):
            data = path.read_bytes()

            result, _ = _run(data, caplog)

            assert isinstance(result, CropResult), path.name
            assert result.source == "tiered", path.name
            assert result.image_bytes is data
        assert stage_spy == []
