"""Step B, L1: the direct path equals rembg 2.0.78 on this host, bit for bit.

Three equalities per fixture, each guarding one stage, plus synthetic edge
cases for the pre- and post-processing alone. Same host and same process, so
there is no tolerance anywhere in this file.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from tests.parity import _parity


def test_the_oracle_is_rembg_2_0_78_on_the_pinned_original(config):
    from importlib import metadata

    from app.cropper import birefnet

    assert metadata.version("rembg") == "2.0.78"
    pin = _parity.load_script("bake_birefnet").SOURCES[birefnet.model_name()]
    assert _parity.sha256_file(config.original_model) == pin["sha256"]
    md5 = hashlib.md5(config.original_model.read_bytes())  # noqa: S324 - rembg's pin
    assert md5.hexdigest() == pin["md5"]
    # The direct side loads the baked file, not the original.
    assert Path(birefnet.model_path()).resolve() != config.original_model.resolve()


def test_rembg_feeds_the_model_what_preprocess_makes(runs, fixture_name):
    from app.cropper import birefnet

    run = runs[fixture_name]
    got = birefnet.preprocess(Image.fromarray(run.padded))
    assert not _parity.array_problems("input tensor", got, run.fed)


def test_rembg_raw_output_replayed_through_postprocess_is_rembgs_alpha(runs, fixture_name):
    from app.cropper import birefnet

    run = runs[fixture_name]
    size = (run.padded.shape[1], run.padded.shape[0])
    got = np.array(birefnet.postprocess(run.raw, size))
    assert not _parity.array_problems("replayed alpha", got, run.alpha_rembg)


def test_predict_alpha_on_the_baked_model_is_rembg_remove_on_the_original(runs, fixture_name):
    run = runs[fixture_name]
    assert not _parity.array_problems("end-to-end alpha", run.alpha_direct, run.alpha_rembg)


def test_reference_copies_equal_the_real_functions(runs, fixture_name):
    """The canaries perturb these copies, so they must be exact first."""
    from app.cropper import birefnet

    run = runs[fixture_name]
    img = Image.fromarray(run.padded)
    assert not _parity.array_problems(
        "reference preprocess", _parity.reference_preprocess(img), birefnet.preprocess(img)
    )
    size = img.size
    assert not _parity.array_problems(
        "reference postprocess",
        _parity.reference_postprocess(run.raw, size),
        np.array(birefnet.postprocess(run.raw, size)),
    )


# ── Synthetic edge cases: pre/post only, against rembg's own functions ──────


def _rembg_normalize(img: Image.Image) -> np.ndarray:
    """rembg's `BaseSession.normalize`, called unbound on a stand-in session."""
    from rembg.sessions.base import BaseSession

    from app.cropper import birefnet

    class _Input:
        name = "input_image"

    class _Inner:
        def get_inputs(self):
            return [_Input()]

    stand_in = type("S", (), {"inner_session": _Inner()})()
    feed = BaseSession.normalize(stand_in, img, birefnet.MEAN, birefnet.STD, birefnet.INPUT_SIZE)
    return feed["input_image"]


def _rembg_predict(raw: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """rembg's `BiRefNetSessionGeneral.predict` with its inner session stubbed."""
    from rembg.sessions.birefnet_general import BiRefNetSessionGeneral

    session = BiRefNetSessionGeneral.__new__(BiRefNetSessionGeneral)

    class _Inner:
        def get_inputs(self):
            return [type("I", (), {"name": "input_image"})()]

        def run(self, _names, _feed):
            return [raw]

    session.inner_session = _Inner()
    (mask,) = session.predict(Image.new("RGB", size))
    return np.array(mask)


_SYNTHETIC_IMAGES = {
    "black": lambda: np.zeros((300, 200, 3), np.uint8),
    "white": lambda: np.full((200, 300, 3), 255, np.uint8),
    "one-pixel": lambda: np.full((1, 1, 3), 77, np.uint8),
    "dim": lambda: np.random.default_rng(1).integers(0, 9, (517, 389, 3), dtype=np.uint8),
    "noise-large": lambda: np.random.default_rng(2).integers(
        0, 256, (1400, 1000, 3), dtype=np.uint8
    ),
    "exact-1024": lambda: np.random.default_rng(3).integers(
        0, 256, (1024, 1024, 3), dtype=np.uint8
    ),
}


@pytest.mark.parametrize("case", sorted(_SYNTHETIC_IMAGES))
def test_preprocess_edge_cases_match_rembg(case):
    from app.cropper import birefnet

    img = Image.fromarray(_SYNTHETIC_IMAGES[case]())
    assert not _parity.array_problems(case, birefnet.preprocess(img), _rembg_normalize(img))


_SYNTHETIC_RAW = {
    "logits": lambda: np.random.default_rng(4).normal(0, 6, (1, 1, 1024, 1024)).astype(np.float32),
    "saturated": lambda: np.random.default_rng(5).choice(
        np.array([-120.0, 120.0], np.float32), (1, 1, 1024, 1024)
    ),
    "constant": lambda: np.full((1, 1, 1024, 1024), 0.5, np.float32),
    "two-channels": lambda: (
        np.random.default_rng(6).normal(0, 3, (1, 2, 1024, 1024)).astype(np.float32)
    ),
}


@pytest.mark.parametrize("case", sorted(_SYNTHETIC_RAW))
@pytest.mark.parametrize("size", [(1024, 1024), (731, 1013), (1, 1), (1500, 40)])
def test_postprocess_edge_cases_match_rembg(case, size):
    from app.cropper import birefnet

    raw = _SYNTHETIC_RAW[case]()
    with np.errstate(over="ignore", divide="ignore", invalid="ignore"):
        want = _rembg_predict(raw, size)
    got = np.array(birefnet.postprocess(raw, size))
    assert not _parity.array_problems(f"{case} at {size}", got, want)
