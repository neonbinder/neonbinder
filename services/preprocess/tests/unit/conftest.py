"""Unit-suite guardrails.

Unit tests must never download model weights or touch the network. The
tiered strategy's BiRefNet fallback creates a rembg session on first use,
and `rembg.new_session` DOWNLOADS the model when it isn't cached — so a
test that accidentally reaches it would pull ~1GB in CI. Block it by
default; tests that exercise the session plumbing monkeypatch
`rembg.new_session` themselves, which overrides this guard for their
duration.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _block_rembg_session_creation(monkeypatch):
    def _refuse(*_args, **_kwargs):
        raise AssertionError(
            "unit tests must not create a real rembg session (model download); "
            "stub app.cropper.tiered.birefnet_mask / tiered_crop or monkeypatch "
            "rembg.new_session in the test"
        )

    monkeypatch.setattr("rembg.new_session", _refuse)

    # Start every test with an empty session cache so a fake injected by one
    # test can never leak into another (monkeypatch restores afterwards).
    from app.cropper import tiered

    monkeypatch.setattr(tiered, "_session", None)
