"""Unit-suite guardrails.

Unit tests must never load model weights. Since NEO-484 the BiRefNet session
is built in exactly one place, `app.cropper.birefnet._new_inference_session`,
so blocking that factory blocks every route to a real ~930 MB ONNX session
(the image bakes the model; a dev machine or CI runner has none, and a test
that got this far would be loading a real model into memory). Tests that
exercise the session plumbing monkeypatch `_new_inference_session` themselves,
which overrides this guard for their duration; tests of the crop pipeline stub
`birefnet.predict_alpha` (or `tiered.birefnet_mask` / `tiered_crop`).

The SAM crop fallback is guarded the same way (`app.cropper.sam._load_model`).
A runner that has torch and transformers installed (CI installs the service's
full requirements) would otherwise really download and run the ~375 MB SAM
model for every test whose cascade falls through to that stage: ~10 s each on
a 2-core runner, ~14 min of a ~15 min job, against ~0.1 s on a machine
without torch where the stage's import fails and the cascade falls through.
The guard makes both environments behave like the second. A test that wants
the stage to run stubs `_load_model` itself, which overrides this guard.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _block_birefnet_session_creation(monkeypatch):
    from app.cropper import birefnet

    def _refuse(*_args, **_kwargs):
        raise AssertionError(
            "unit tests must not create a real BiRefNet ORT session; stub "
            "app.cropper.birefnet.predict_alpha (or tiered.birefnet_mask / tiered_crop), "
            "or monkeypatch birefnet._new_inference_session in the test"
        )

    monkeypatch.setattr(birefnet, "_new_inference_session", _refuse)

    # Start every test with an empty session cache so a fake injected by one
    # test can never leak into another (monkeypatch restores afterwards).
    monkeypatch.setattr(birefnet, "_session", None)


@pytest.fixture(autouse=True)
def _block_sam_model_load(monkeypatch):
    from app.cropper import sam

    def _refuse(*_args, **_kwargs):
        # sam_crop turns any load failure into "stage produced nothing", which
        # is exactly what an environment without torch does.
        raise RuntimeError("unit tests must not load the real SAM model")

    monkeypatch.setattr(sam, "_load_model", _refuse)
