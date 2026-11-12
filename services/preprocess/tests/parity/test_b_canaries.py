"""Step B, canaries: each plausible slip must be caught by the check guarding it.

A parity suite that passes everything proves nothing. On every fixture, each
of these mutations must make the check that the real suite runs report a
problem:

  - BILINEAR instead of LANCZOS, and mean +1e-7: the L1 input-tensor check.
  - no sigmoid, and x254 instead of x255: the L1 replay check.
  - alpha +1: the L2 goldens check (exact or within tolerance).
"""

from __future__ import annotations

import pytest
from PIL import Image

from tests.parity import _parity

PRE_CANARIES = {
    "bilinear": {"resample": Image.Resampling.BILINEAR},
    "mean+1e-7": {"mean_shift": 1e-7},
}
POST_CANARIES = {
    "no-sigmoid": {"sigmoid": False},
    "x254": {"scale": 254},
}


@pytest.mark.parametrize("canary", sorted(PRE_CANARIES))
def test_preprocess_canary_is_caught(runs, fixture_name, canary):
    run = runs[fixture_name]
    mutated = _parity.reference_preprocess(Image.fromarray(run.padded), **PRE_CANARIES[canary])
    assert _parity.array_problems("input tensor", mutated, run.fed), (
        f"{canary} went unnoticed on {fixture_name}"
    )


@pytest.mark.parametrize("canary", sorted(POST_CANARIES))
def test_postprocess_canary_is_caught(runs, fixture_name, canary):
    run = runs[fixture_name]
    size = (run.padded.shape[1], run.padded.shape[0])
    mutated = _parity.reference_postprocess(run.raw, size, **POST_CANARIES[canary])
    assert _parity.array_problems("replayed alpha", mutated, run.alpha_rembg), (
        f"{canary} went unnoticed on {fixture_name}"
    )


def test_alpha_plus_one_canary_is_caught(
    runs, goldens, golden_masks, golden_alpha, host_key, fixture_name
):
    run = runs[fixture_name]
    fx = goldens["fixtures"][fixture_name]
    mutated = _parity.alpha_plus_one(run.alpha_direct)
    # This host's own mode, then both modes whatever this host is: the
    # goldens' own fingerprint (exact) and one they never recorded (tolerance).
    for key in (host_key, goldens["golden_fingerprint"], "not-a-recorded-fingerprint"):
        result = _parity.golden_check(golden_masks, mutated, fx, goldens, key, golden_alpha)
        assert result.problems, f"alpha +1 went unnoticed on {fixture_name} ({result.mode})"
