"""Unit-suite guardrails.

Unit tests must never load model weights. Since NEO-484 the BiRefNet session
is built in exactly one place, `app.cropper.birefnet._new_inference_session`,
so blocking that factory blocks every route to a real ~930 MB ONNX session
(the image bakes the model; a dev machine or CI runner has none, and a test
that got this far would be loading a real model into memory). Tests that
exercise the session plumbing monkeypatch `_new_inference_session` themselves,
which overrides this guard for their duration; tests of the crop pipeline stub
`birefnet.predict_alpha` (or `tiered.birefnet_mask` / `tiered_crop`).
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
