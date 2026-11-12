"""The NEO-484 mask-parity suite: run only inside the parity images, by CI.

`preprocess-mask-parity` (pr-pipeline.yml) builds two images on this PR's
pinned preprocess image (`tests/parity/Dockerfile`) and runs this directory
in each, offline, read-only, as the image's own non-root user:

  - PARITY_STAGE=base   (target `check`, shard 0 only): `test_a_base.py`.
    The image as shipped: rembg's stack is gone, the baked model's
    provenance, hash file and permissions, the session loads, SAM runs.
  - PARITY_STAGE=oracle (target `oracle`, every shard): `test_b_*.py`.
    rembg 2.0.78 installed from `requirements-oracle.txt` is the oracle:
      L1  same host, exact: the tensor rembg feeds the model equals
          `birefnet.preprocess`; rembg's raw output replayed through
          `birefnet.postprocess` equals rembg's alpha; and end to end
          `birefnet.predict_alpha` on the baked (EXTENDED-optimised) model
          equals `rembg.remove(...)[..., 3]` on the original model.
      L2  the committed goldens (`goldens/manifest.json`): exact on a
          fingerprint they recorded, otherwise within their T, F, N with a
          warning; the quad tiered derives must sit within 1 px per corner.
      Canaries: BILINEAR, mean +1e-7, no sigmoid, x254 and alpha +1 must
          each be caught by the check that guards that step.

Every fixture in PARITY_FIXTURES_DIR is compared (sharded by sorted index
modulo PARITY_SHARD_COUNT), and the directory must match the goldens exactly.
A skipped test fails the run: nothing here is optional.

Regenerating the goldens (only with a deliberate change to the model, the
transcription or the fixtures; see the service README): run
`scripts/golden_masks.py generate --impl rembg` in the CURRENT image on Cloud
Run hosts, then `golden_masks.py hash RUN_DIR... --out tests/parity/goldens
--tolerance T,F,N`, and commit the result.
"""

from __future__ import annotations

import gc
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from tests.parity import _parity

_parity.env_defaults(os.environ)  # before rembg/numba/transformers are imported

CONFIG = _parity.config_from_env(os.environ)

collect_ignore_glob = ["test_b_*.py"] if CONFIG.stage == "base" else ["test_a_*.py"]


# ── Nothing may be skipped ──────────────────────────────────────────────────

_skipped: list[str] = []


def pytest_runtest_logreport(report: pytest.TestReport) -> None:
    if report.skipped:
        _skipped.append(report.nodeid)


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    if _skipped and exitstatus == 0:
        session.exitstatus = 1


def pytest_terminal_summary(terminalreporter: Any) -> None:
    if _skipped:
        terminalreporter.write_line(
            f"PARITY FAILED: {len(_skipped)} test(s) skipped; every parity check must run:",
            red=True,
        )
        for nodeid in _skipped:
            terminalreporter.write_line(f"  {nodeid}", red=True)


# ── Goldens, fixtures, shard ────────────────────────────────────────────────


def _load_goldens() -> dict[str, Any]:
    path = CONFIG.goldens_dir / "manifest.json"
    if not path.is_file():
        raise _parity.ParityConfigError(
            f"no goldens at {path}; generate them with scripts/golden_masks.py (conftest docstring)"
        )
    return json.loads(path.read_text())


GOLDENS = _load_goldens()
SHARD = _parity.shard(list(GOLDENS.get("fixtures") or {}), CONFIG.shard_index, CONFIG.shard_count)


def pytest_generate_tests(metafunc: pytest.Metafunc) -> None:
    if "fixture_name" in metafunc.fixturenames:
        metafunc.parametrize("fixture_name", SHARD)


@pytest.fixture(scope="session")
def config() -> _parity.Config:
    return CONFIG


@pytest.fixture(scope="session")
def golden_masks():
    """`scripts/golden_masks.py`: the goldens' hashing, diff and fingerprint."""
    return _parity.load_script("golden_masks")


@pytest.fixture(scope="session")
def goldens(golden_masks) -> dict[str, Any]:
    problems = _parity.goldens_problems(GOLDENS, CONFIG.goldens_dir)
    assert not problems, "goldens incomplete:\n  " + "\n  ".join(problems)
    assert GOLDENS["format"] == golden_masks.MANIFEST_FORMAT
    return GOLDENS


@pytest.fixture(scope="session")
def fixtures_dir(goldens) -> Path:
    problems = _parity.fixture_problems(goldens, CONFIG.fixtures_dir)
    assert not problems, "fixtures do not match the goldens:\n  " + "\n  ".join(problems)
    assert SHARD, f"shard {CONFIG.shard_index} of {CONFIG.shard_count} has no fixtures"
    return CONFIG.fixtures_dir


@pytest.fixture
def golden_alpha(goldens, golden_masks, fixture_name) -> np.ndarray:
    """The golden alpha plane (the goldens' own fingerprint) for this fixture."""
    return golden_masks.read_png(
        CONFIG.goldens_dir / goldens["fixtures"][fixture_name]["alpha_png"]
    )


# ── The oracle and the direct path, run once per shard ──────────────────────


class _Spy:
    """Wraps rembg's ORT session to record what it fed the model and got back."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.calls: list[tuple[np.ndarray, np.ndarray]] = []

    def run(self, output_names: Any, input_feed: dict[str, np.ndarray], *args: Any, **kw: Any):
        outs = self._inner.run(output_names, input_feed, *args, **kw)
        (fed,) = input_feed.values()
        self.calls.append((np.array(fed, copy=True), np.array(outs[0], copy=True)))
        return outs

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


@dataclass
class Run:
    name: str
    work: np.ndarray  # BGR at work resolution, as tiered sees it
    padded: np.ndarray  # RGB, exactly what predict_alpha receives
    pad: int
    fed: np.ndarray  # the tensor rembg fed the original model
    raw: np.ndarray  # the original model's first output
    alpha_rembg: np.ndarray
    alpha_direct: np.ndarray


def _rembg_session(model: str) -> Any:
    """rembg's session as the old `tiered._get_session` built it: arena off."""
    import onnxruntime as ort
    from rembg import new_session

    opts = ort.SessionOptions()
    opts.enable_cpu_mem_arena = False
    return new_session(model, sess_opts=opts)


@pytest.fixture(scope="session")
def runs(fixtures_dir, golden_masks) -> dict[str, Run]:
    """rembg on the original model, then predict_alpha on the baked one.

    One session at a time (the rembg one is dropped before the direct one
    loads), so the job's peak memory is one model.
    """
    from rembg import remove

    from app.cropper import birefnet, tiered

    model = birefnet.model_name()
    original = CONFIG.original_model
    assert original is not None
    rembg_file = Path(os.environ["U2NET_HOME"]) / f"{model}.onnx"
    assert rembg_file.resolve() == original.resolve(), (
        f"rembg would load {rembg_file}, not the verified original {original}"
    )

    prepared = {}
    for name in SHARD:
        _full, work, _scale = tiered._load((fixtures_dir / name).read_bytes())
        padded, pad = golden_masks._padded_input(work)
        prepared[name] = (work, padded, pad)

    session = _rembg_session(model)
    spy = _Spy(session.inner_session)
    session.inner_session = spy
    oracle = {}
    for name, (_work, padded, _pad) in prepared.items():
        spy.calls.clear()
        alpha = np.array(np.asarray(remove(padded, session=session))[..., 3])
        assert len(spy.calls) == 1, f"{name}: rembg ran the model {len(spy.calls)} times"
        oracle[name] = (*spy.calls[0], alpha)
        print(f"oracle {name}: rembg done", file=sys.stderr, flush=True)
    del session, spy
    gc.collect()

    birefnet.load_session()
    out = {}
    for name, (work, padded, pad) in prepared.items():
        fed, raw, alpha_rembg = oracle[name]
        out[name] = Run(
            name=name,
            work=work,
            padded=padded,
            pad=pad,
            fed=fed,
            raw=raw,
            alpha_rembg=alpha_rembg,
            alpha_direct=birefnet.predict_alpha(padded),
        )
        print(f"oracle {name}: direct done", file=sys.stderr, flush=True)
    return out


@pytest.fixture(scope="session")
def host_key(golden_masks) -> str:
    """This host's fingerprint key, computed as the goldens' runs computed theirs."""
    fp = golden_masks.host_fingerprint(golden_masks.model_info("direct"))
    key = golden_masks.fingerprint_key(fp)
    print(f"parity host fingerprint {key}: {json.dumps(fp, sort_keys=True)}", flush=True)
    return key
