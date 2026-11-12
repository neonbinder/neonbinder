"""Step B, L2: the direct path against the committed goldens.

The goldens were made by rembg in the image deployed before NEO-484, on Cloud
Run hosts. A host whose fingerprint they recorded must reproduce them
exactly; any other host (a CI runner, typically) must land within the
manifest's T, F, N and gets a warning. Either way, the quad tiered derives
from the mask must sit within 1 px per corner of the goldens' quad, because
the geometry, not the alpha, is what reaches a card.
"""

from __future__ import annotations

import warnings

from tests.parity import _parity


def test_this_run_saw_the_goldens_inputs(runs, goldens, fixture_name):
    run = runs[fixture_name]
    fx = goldens["fixtures"][fixture_name]
    problems = _parity.input_problems(fx, run.work.shape[:2], run.pad, run.padded.shape[:2])
    assert not problems, problems


def test_alpha_matches_the_goldens(
    runs, goldens, golden_masks, golden_alpha, host_key, fixture_name
):
    run = runs[fixture_name]
    fx = goldens["fixtures"][fixture_name]
    result = _parity.golden_check(
        golden_masks, run.alpha_direct, fx, goldens, host_key, golden_alpha
    )
    assert not result.problems, f"{fixture_name} ({result.mode}): {result.problems}"
    if result.mode == "tolerance" and result.stats and not result.stats["identical"]:
        msg = (
            f"{fixture_name}: host {host_key} is not a recorded fingerprint; "
            f"within tolerance, not exact: {result.stats}"
        )
        print(f"::warning::mask parity {msg}", flush=True)
        warnings.warn(msg, stacklevel=1)


def test_quad_matches_the_goldens(runs, golden_alpha, fixture_name):
    run = runs[fixture_name]
    want = _parity.components_for_alpha(golden_alpha, run.work)
    got = _parity.components_for_alpha(run.alpha_direct, run.work)
    problems = _parity.quad_problems(got, want)
    assert not problems, f"{fixture_name}: {problems}"
