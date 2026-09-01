"""Crop / deskew / rotate matrix against a DEPLOYED preprocess service (NEO-191).

## Why this suite exists, and why it is not in E2E

The 2026-08-27 border-shaving bug shipped to production and ran for a week with
every other gate green. E2E could not see it: Maestro drives rendered UI, and a
card cropped to 87% of itself still renders, still classifies, still pairs. The
defect was a geometric property of bytes the UI never asserts on.

So this suite asserts the geometry directly, against the real container — real
BiRefNet weights, real Cloud Run CPU — because the crop cascade's behaviour is
a property of the deployed artifact, not of an in-process import. The unit
suite cannot substitute: `tests/unit/conftest.py` deliberately blocks
`rembg.new_session` so no unit test can ever run the model.

## What each fixture asserts

Two shapes, chosen per fixture by `crop.identity` in its sidecar:

  identity: true   the server must return the upload UNTOUCHED. For an
                   already-tight scan that is the only correct answer, and
                   `cropped_image_b64 is None` is exactly the assertion that
                   would have caught the production bug on the day it landed.

  identity: false  a crop was required, so the returned bytes are decoded and
                   measured: card aspect within tolerance, and area inside a
                   band calibrated from a real run. Covers cropping AND
                   deskewing — a skewed card that is cropped but not
                   straightened fails the aspect check.

`rotation_degrees` is asserted wherever a sidecar declares `orient:`. It is the
one externally-sourced assertion here (Cloud Vision derives it from OCR), so if
it ever flakes on a Vision model change, relax that field first — the crop
assertions are our own code and should be held strictly.

## Cost and runtime

One `/process` per fixture: ~$0.005 of Vision + Haiku each, ~$0.06 a run. Warm,
the pre-cropped fixtures answer in ~3s (they never reach BiRefNet, which is the
whole point of NEO-191) and each bed scan or phone photo pays ~45s. Requests
are issued concurrently at the service's own concurrency limit, so the matrix
lands in ~2 min — comfortably inside the E2E window it runs beside.
"""

from __future__ import annotations

import base64
import io
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

import httpx
import pytest
from PIL import Image

from tests.integration._loader import CropExpectation, FixtureCase, load_fixtures

from .conftest import MAX_CONCURRENCY


def _crop_cases() -> list[FixtureCase]:
    """Fixtures whose sidecar declares a `crop:` block.

    `load_fixtures` discovers by IMAGE presence, so a machine that has not run
    `scripts/fetch_fixtures.py --crop` yields an empty list — which would make
    this suite silently green having asserted nothing. `test_matrix_is_complete`
    below is the guard against exactly that; do not remove it.
    """
    return [c for c in load_fixtures() if c.crop is not None]


def _declared_crop_sidecars() -> list[str]:
    """Sidecar stems declaring `crop:`, read from git-tracked YAML alone.

    Deliberately independent of whether any image was fetched — this is the
    'what SHOULD have run' side of the completeness check.
    """
    import yaml

    from tests.integration._loader import FIXTURES_DIR

    stems = []
    for sidecar in sorted(FIXTURES_DIR.glob("*.yaml")):
        raw = yaml.safe_load(sidecar.read_text()) or {}
        if raw.get("crop") is not None:
            stems.append(sidecar.stem)
    return stems


CASES = _crop_cases()


# Retries for TRANSPORT failures only — a 502/503/504 or a dropped connection.
# The service reaches Cloud Vision over gRPC, and Vision returns a transient
# `UNAVAILABLE:502:Bad Gateway` often enough to have shown up on the first run
# of this suite; the preprocess route maps that to its own 502. A blocking gate
# must not turn someone else's transient outage into a blocked merge. This
# never retries an assertion — a wrong crop fails on the first response.
TRANSIENT_STATUS = frozenset({502, 503, 504})
MAX_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = 5.0


@dataclass(frozen=True)
class Outcome:
    """One fixture's `/process` response, plus the geometry we measured.

    `error` is set instead of `body` when the request never produced a usable
    response. It is carried per fixture rather than raised, so one unreachable
    image cannot error out the whole batch and cost every other fixture its
    verdict — losing per-card attribution is precisely what makes E2E a poor
    place for this, and it would be self-defeating to reproduce it here.
    """

    case: FixtureCase
    body: dict[str, Any] | None
    source_size: tuple[int, int]
    crop_size: tuple[int, int] | None
    error: str | None = None

    @property
    def expected(self) -> CropExpectation:
        assert self.case.crop is not None
        return self.case.crop


def _process_one(client: httpx.Client, headers: dict[str, str], case: FixtureCase) -> Outcome:
    image_bytes = case.image_path.read_bytes()
    with Image.open(io.BytesIO(image_bytes)) as img:
        source_size = img.size

    last_error = "never attempted"
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            response = client.post(
                "/process",
                headers=headers,
                files={"image": (case.image_path.name, image_bytes, case.content_type)},
                data={"crop_quality": "fast"},
            )
        except httpx.HTTPError as exc:
            last_error = f"transport error: {type(exc).__name__}: {exc}"
        else:
            if response.status_code == 200:
                body = response.json()
                crop_size = None
                if body.get("cropped_image_b64"):
                    with Image.open(io.BytesIO(base64.b64decode(body["cropped_image_b64"]))) as img:
                        crop_size = img.size
                return Outcome(case=case, body=body, source_size=source_size, crop_size=crop_size)
            last_error = f"HTTP {response.status_code}: {response.text[:300]}"
            if response.status_code not in TRANSIENT_STATUS:
                break  # a 4xx is our fault and will not improve on a retry

        if attempt < MAX_ATTEMPTS:
            print(f"  {case.name}: attempt {attempt}/{MAX_ATTEMPTS} failed ({last_error}) — retry")
            time.sleep(RETRY_BACKOFF_SECONDS)

    return Outcome(
        case=case,
        body=None,
        source_size=source_size,
        crop_size=None,
        error=f"{last_error} (after {MAX_ATTEMPTS} attempt(s))",
    )


@pytest.fixture(scope="session")
def outcomes(client: httpx.Client, auth_headers: dict[str, str]) -> dict[str, Outcome]:
    """Run the whole matrix once, concurrently; tests then assert on the results.

    Batching here rather than per-test is what keeps the wall-clock at ~2 min:
    a serial run would be the sum of every BiRefNet pass. Each fixture still
    gets its own test id, so a failure names the card rather than the batch.
    """
    if not CASES:
        pytest.fail(
            "no fixtures with a `crop:` sidecar have images present — "
            "run `python scripts/fetch_fixtures.py --crop` first"
        )

    with ThreadPoolExecutor(max_workers=MAX_CONCURRENCY) as pool:
        results = list(pool.map(lambda c: _process_one(client, auth_headers, c), CASES))
    return {o.case.name: o for o in results}


def test_matrix_is_complete():
    """Every sidecar declaring `crop:` must have produced a case.

    A missing image makes `load_fixtures` skip it silently, so without this the
    suite could pass having tested three cards instead of eleven — the same
    "green run that ran nothing" failure the CI workflow guards against on its
    secret fetches.
    """
    declared = set(_declared_crop_sidecars())
    loaded = {c.name for c in CASES}
    assert declared, "no sidecar declares a `crop:` block — the matrix is empty"
    assert loaded == declared, (
        f"fixture images missing for {sorted(declared - loaded)} "
        f"(run `python scripts/fetch_fixtures.py --crop`)"
    )


def _require_response(outcome: Outcome) -> None:
    """Fail this one fixture, with its own name, when the request never landed."""
    if outcome.error is not None:
        pytest.fail(f"{outcome.case.name}: no usable response — {outcome.error}")


@pytest.mark.parametrize("case", CASES, ids=[c.name for c in CASES])
def test_crop_source(case: FixtureCase, outcomes: dict[str, Outcome]):
    """The cascade routed this image through the stage we expect."""
    outcome = outcomes[case.name]
    _require_response(outcome)
    actual = outcome.body["cropped_source"]
    assert actual == outcome.expected.source, (
        f"{case.name} [{outcome.expected.category}]: routed to {actual!r}, "
        f"expected {outcome.expected.source!r}"
    )


@pytest.mark.parametrize("case", CASES, ids=[c.name for c in CASES])
def test_crop_geometry(case: FixtureCase, outcomes: dict[str, Outcome]):
    """An identity was returned untouched, or a crop is the right shape and size."""
    outcome = outcomes[case.name]
    _require_response(outcome)
    expected = outcome.expected
    src_w, src_h = outcome.source_size

    if expected.identity:
        assert outcome.crop_size is None, (
            f"{case.name} [{expected.category}]: expected the upload back untouched, "
            f"but the server returned a {outcome.crop_size} crop of a {src_w}x{src_h} "
            f"source ({100 * outcome.crop_size[0] * outcome.crop_size[1] / (src_w * src_h):.1f}% "
            f"of it) — this is the border-shaving regression NEO-191 fixed"
        )
        return

    assert outcome.crop_size is not None, (
        f"{case.name} [{expected.category}]: expected a crop, got the input untouched"
    )
    crop_w, crop_h = outcome.crop_size

    if expected.aspect is not None:
        aspect = min(crop_w, crop_h) / max(crop_w, crop_h)
        assert abs(aspect - expected.aspect) <= expected.aspect_tolerance, (
            f"{case.name} [{expected.category}]: crop is {crop_w}x{crop_h}, aspect "
            f"{aspect:.4f}, expected {expected.aspect} +/-{expected.aspect_tolerance}. "
            f"An off-ratio crop on a skewed source usually means the deskew did not run."
        )

    fraction = (crop_w * crop_h) / (src_w * src_h)
    if expected.min_area_fraction is not None:
        assert fraction >= expected.min_area_fraction, (
            f"{case.name} [{expected.category}]: crop covers {fraction:.3f} of the "
            f"{src_w}x{src_h} source, below the {expected.min_area_fraction} floor — "
            f"too small, the card was probably shaved or a fragment was picked"
        )
    if expected.max_area_fraction is not None:
        assert fraction <= expected.max_area_fraction, (
            f"{case.name} [{expected.category}]: crop covers {fraction:.3f} of the "
            f"{src_w}x{src_h} source, above the {expected.max_area_fraction} ceiling — "
            f"too big, the bed or neighbouring cards were probably included"
        )


@pytest.mark.parametrize(
    "case",
    [c for c in CASES if c.rotation_degrees is not None],
    ids=[c.name for c in CASES if c.rotation_degrees is not None],
)
def test_rotation(case: FixtureCase, outcomes: dict[str, Outcome]):
    """The upright rotation Vision derived matches what the sidecar recorded.

    The one assertion here sourced from outside our own code — see the module
    docstring on relaxing it if Vision ever drifts.
    """
    outcome = outcomes[case.name]
    _require_response(outcome)
    actual = outcome.body["rotation_degrees"]
    assert actual == case.rotation_degrees, (
        f"{case.name}: rotation {actual}, expected {case.rotation_degrees}"
    )
