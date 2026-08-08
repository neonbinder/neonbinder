"""End-to-end test: real Vision + Anthropic calls against images in tests/fixtures/.

Each image may have a YAML sidecar declaring expectations. Shape assertions
(keys present, valid enum values) run for every fixture; specific assertions
run only for fields the sidecar declares.

Add new fixtures by dropping an image into tests/fixtures/ and running
`scripts/label_fixtures.py` to bootstrap a draft sidecar. Edit the sidecar to
loosen (equals→contains) where Haiku drift is expected, or tighten as needed.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import MAX_IMAGE_BYTES, app

from ._loader import FixtureCase, load_fixtures

_FIXTURES = load_fixtures()

if not _FIXTURES:
    pytest.skip(
        "no images in tests/fixtures/ — drop some in and re-run",
        allow_module_level=True,
    )

client = TestClient(app)

INTERNAL_KEY = "integration-test-key"


@pytest.fixture(autouse=True)
def _set_internal_key(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_KEY", INTERNAL_KEY)


@pytest.mark.parametrize("case", _FIXTURES, ids=[c.name for c in _FIXTURES])
def test_fixture_end_to_end(case: FixtureCase):
    image_bytes = case.image_path.read_bytes()
    assert len(image_bytes) <= MAX_IMAGE_BYTES, (
        f"{case.name}: {len(image_bytes):,} bytes exceeds MAX_IMAGE_BYTES "
        f"({MAX_IMAGE_BYTES:,}). Downscale the fixture or raise the limit."
    )

    response = client.post(
        "/process",
        headers={"x-internal-key": INTERNAL_KEY},
        files={"image": (case.image_path.name, image_bytes, case.content_type)},
    )

    assert response.status_code == 200, f"{case.name}: HTTP {response.status_code}: {response.text}"
    body = response.json()

    # Shape assertions — every fixture, sidecar or not.
    assert set(body.keys()) == {
        "players",
        "player",
        "team",
        "card_number",
        "side",
        "rotation_degrees",
        "orient_confidence",
        "text_count",
        "cropped_source",
        "cropped_image_b64",
    }, f"{case.name}: unexpected response keys {sorted(body.keys())}"
    assert body["side"] in {"front", "back"}, f"{case.name}: bad side {body['side']!r}"
    assert body["rotation_degrees"] in {
        0,
        90,
        180,
        270,
    }, f"{case.name}: bad rotation {body['rotation_degrees']!r}"
    assert 0.0 <= body["orient_confidence"] <= 1.0
    assert body["text_count"] >= 0
    # The committed fixtures are phone-camera photos (16:9 aspect) of cards,
    # not already-tight card crops, so the cascade usually falls through to
    # passthrough in slice 2a (no SAM yet). Just verify the source is a
    # known label and the b64 field is consistent with it.
    assert body["cropped_source"] in {
        "precropped",
        "pil_trim_dark",
        "pil_trim_light",
        "sam",
        "passthrough",
    }, f"{case.name}: unexpected cropped_source {body['cropped_source']!r}"
    if body["cropped_source"] == "precropped":
        assert (
            body["cropped_image_b64"] is None
        ), f"{case.name}: cropped_image_b64 should be null when source==precropped"

    # Sidecar-specific assertions.
    if case.rotation_degrees is not None:
        assert body["rotation_degrees"] == case.rotation_degrees, (
            f"{case.name}: rotation {body['rotation_degrees']}, "
            f"expected {case.rotation_degrees}"
        )
    if case.min_confidence is not None:
        assert body["orient_confidence"] >= case.min_confidence, (
            f"{case.name}: confidence {body['orient_confidence']:.2f} below floor "
            f"{case.min_confidence:.2f}"
        )
    if case.side is not None:
        assert (
            body["side"] == case.side
        ), f"{case.name}: side {body['side']!r}, expected {case.side!r}"
    if case.player is not None:
        case.player.check(body["player"], f"{case.name}.player")
    if case.team is not None:
        case.team.check(body["team"], f"{case.name}.team")
    if case.card_number is not None:
        case.card_number.check(body["card_number"], f"{case.name}.card_number")
