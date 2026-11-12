"""Helpers for the NEO-484 mask-parity suite (`tests/parity/`).

Pure functions only: configuration from the environment, the fixture/goldens
checks, sharding, the L1/L2 comparisons and the mutable reference copies the
canaries perturb. Nothing here loads a model, so the unit suite tests these
directly (`tests/unit/test_parity_helpers.py`) and the expensive job runs
only checks that were already proven to fire.

The comparisons return a list of problems (empty means pass) instead of
asserting, so a canary can prove that the very check the suite runs reports
a deliberately broken implementation.
"""

from __future__ import annotations

import hashlib
import importlib.util
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Any
from unittest import mock

import numpy as np
from PIL import Image

PARITY_DIR = Path(__file__).resolve().parent
SERVICE_ROOT = PARITY_DIR.parents[1]
GOLDENS_DIR = PARITY_DIR / "goldens"

STAGES = ("base", "oracle")
STAGE_ENV = "PARITY_STAGE"
FIXTURES_ENV = "PARITY_FIXTURES_DIR"
ORIGINAL_MODEL_ENV = "PARITY_ORIGINAL_MODEL"
SHARD_INDEX_ENV = "PARITY_SHARD_INDEX"
SHARD_COUNT_ENV = "PARITY_SHARD_COUNT"
# Optional: another goldens directory (a local run, or a regeneration check).
GOLDENS_ENV = "PARITY_GOLDENS_DIR"

# rembg's stack, which left the image with NEO-484 (plan decision 1). Import
# names, not distribution names.
ABSENT_FROM_IMAGE = (
    "rembg",
    "pymatting",
    "numba",
    "llvmlite",
    "scipy",
    "skimage",
    "pooch",
    "jsonschema",
)

# The quad tiered derives from a parity mask must sit within this distance of
# the goldens' quad, per corner, in work-image pixels (plan: "1 px per corner").
QUAD_TOLERANCE_PX = 1.0


class ParityConfigError(RuntimeError):
    """The job was started without what the suite needs; fail, never skip."""


# ── Scripts the suite reuses (loaded by path: `scripts/` is not a package) ──


def load_script(name: str) -> ModuleType:
    path = SERVICE_ROOT / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"_parity_{name}", path)
    if spec is None or spec.loader is None:
        raise ParityConfigError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ── Configuration ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Config:
    stage: str
    fixtures_dir: Path
    original_model: Path | None
    shard_index: int
    shard_count: int
    goldens_dir: Path = GOLDENS_DIR


def config_from_env(environ: Mapping[str, str]) -> Config:
    stage = environ.get(STAGE_ENV, "")
    if stage not in STAGES:
        raise ParityConfigError(f"{STAGE_ENV} must be one of {STAGES}, got {stage!r}")
    fixtures = environ.get(FIXTURES_ENV)
    if not fixtures:
        raise ParityConfigError(f"{FIXTURES_ENV} is not set")
    original = environ.get(ORIGINAL_MODEL_ENV)
    if stage == "oracle" and not original:
        raise ParityConfigError(f"{ORIGINAL_MODEL_ENV} is not set (the oracle needs it)")
    try:
        index = int(environ.get(SHARD_INDEX_ENV, "0"))
        count = int(environ.get(SHARD_COUNT_ENV, "1"))
    except ValueError as exc:
        raise ParityConfigError(f"{SHARD_INDEX_ENV}/{SHARD_COUNT_ENV} must be integers") from exc
    if count < 1 or not 0 <= index < count:
        raise ParityConfigError(f"shard {index} of {count} is out of range")
    return Config(
        stage=stage,
        fixtures_dir=Path(fixtures),
        original_model=Path(original) if original else None,
        shard_index=index,
        shard_count=count,
        goldens_dir=Path(environ.get(GOLDENS_ENV) or GOLDENS_DIR),
    )


def shard(names: list[str], index: int, count: int) -> list[str]:
    """Every `count`-th name of the sorted list, starting at `index`.

    The shards of one count are disjoint and together cover every name.
    """
    return [n for i, n in enumerate(sorted(names)) if i % count == index]


# ── Goldens and fixtures ────────────────────────────────────────────────────


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while chunk := fh.read(8 << 20):
            h.update(chunk)
    return h.hexdigest()


def goldens_problems(manifest: Mapping[str, Any], goldens_dir: Path) -> list[str]:
    """A committed goldens manifest must be complete before anything compares to it."""
    problems = []
    if manifest.get("kind") != "goldens":
        problems.append(f"manifest kind is {manifest.get('kind')!r}, not 'goldens'")
    key = manifest.get("golden_fingerprint")
    if key not in (manifest.get("fingerprints") or {}):
        problems.append(f"golden_fingerprint {key!r} is not among the recorded fingerprints")
    tol = manifest.get("tolerance")
    if not isinstance(tol, Mapping) or not {
        "max_alpha_diff",
        "max_alpha_pixel_frac",
        "max_mask_pixels",
    } <= set(tol):
        problems.append("the manifest has no tolerance block (hash --tolerance T,F,N)")
    if not manifest.get("fixtures"):
        problems.append("the manifest lists no fixtures")
    for name, fx in sorted((manifest.get("fixtures") or {}).items()):
        if key not in fx.get("alpha", {}):
            problems.append(f"{name}: no alpha recorded for the golden fingerprint")
        if not (goldens_dir / fx.get("alpha_png", "")).is_file():
            problems.append(f"{name}: golden PNG {fx.get('alpha_png')!r} is missing")
    return problems


def fixture_problems(manifest: Mapping[str, Any], fixtures_dir: Path) -> list[str]:
    """The fixture directory must be exactly the manifest's fixtures, byte for byte.

    A fixture replaced in the bucket, or one added without regenerating the
    goldens, fails here rather than comparing against the wrong golden.
    """
    if not fixtures_dir.is_dir():
        return [f"fixture directory {fixtures_dir} does not exist"]
    present = {p.name: p for p in fixtures_dir.iterdir() if p.is_file()}
    wanted = manifest.get("fixtures") or {}
    problems = [
        f"{n}: in the manifest but not in {fixtures_dir}"
        for n in sorted(set(wanted) - set(present))
    ]
    problems += [
        f"{n}: in {fixtures_dir} but not in the manifest"
        for n in sorted(set(present) - set(wanted))
    ]
    for name in sorted(set(wanted) & set(present)):
        got = sha256_file(present[name])
        if got != wanted[name]["sha256"]:
            problems.append(f"{name}: sha256 {got} != manifest {wanted[name]['sha256']}")
    return problems


def input_problems(
    fx: Mapping[str, Any], work_shape: tuple[int, int], pad: int, padded_shape: tuple[int, int]
) -> list[str]:
    """This run decoded and padded the fixture exactly as the golden run did."""
    problems = []
    if list(work_shape) != list(fx["work_shape"]):
        problems.append(f"work shape {list(work_shape)} != golden {fx['work_shape']}")
    if pad != fx["pad"]:
        problems.append(f"pad {pad} != golden {fx['pad']}")
    if list(padded_shape) != list(fx["padded_shape"]):
        problems.append(f"padded shape {list(padded_shape)} != golden {fx['padded_shape']}")
    return problems


# ── L1: exact comparisons on this host ──────────────────────────────────────


def array_problems(what: str, got: np.ndarray, want: np.ndarray) -> list[str]:
    """Byte equality, with a description of how far apart they are when not."""
    got = np.asarray(got)
    want = np.asarray(want)
    if got.dtype != want.dtype:
        return [f"{what}: dtype {got.dtype} != {want.dtype}"]
    if got.shape != want.shape:
        return [f"{what}: shape {got.shape} != {want.shape}"]
    if got.tobytes() == want.tobytes():
        return []
    d = np.abs(got.astype(np.float64) - want.astype(np.float64))
    return [
        f"{what}: {int(np.count_nonzero(d))} of {d.size} values differ "
        f"(max |d| {float(np.nanmax(d)) if d.size else 0.0:g})"
    ]


# ── L2: against the committed goldens ───────────────────────────────────────


@dataclass
class GoldenResult:
    mode: str  # "exact" (recorded fingerprint) or "tolerance"
    problems: list[str] = field(default_factory=list)
    stats: dict[str, Any] | None = None


def golden_check(
    gm: ModuleType,
    alpha: np.ndarray,
    fx: Mapping[str, Any],
    manifest: Mapping[str, Any],
    host_key: str,
    golden_alpha: np.ndarray,
) -> GoldenResult:
    """Exact on a fingerprint the goldens recorded; within T, F, N otherwise.

    `gm` is `scripts/golden_masks.py`, whose hash and diff the goldens were
    built with, so both sides measure the same way.
    """
    key = manifest["golden_fingerprint"]
    if gm.alpha_sha256(golden_alpha) != fx["alpha"][key]:
        return GoldenResult("tolerance", ["the golden PNG does not match its manifest hash"])
    recorded = fx["alpha"].get(host_key)
    if recorded is not None:
        got = gm.alpha_sha256(alpha)
        problems = [] if got == recorded else [f"alpha {got} != recorded {recorded} for this host"]
        return GoldenResult("exact", problems)
    try:
        stats = gm.diff_alpha(alpha, golden_alpha, fx["pad"], fx["work_shape"])
    except gm.InputMismatchError as exc:
        return GoldenResult("tolerance", [str(exc)])
    tol = manifest["tolerance"]
    problems = [] if gm.within(stats, tol) else [f"outside tolerance {dict(tol)}: {stats}"]
    return GoldenResult("tolerance", problems, stats)


# ── Quads: the geometry tiered derives from an alpha ────────────────────────


def components_for_alpha(alpha_full: np.ndarray, work: np.ndarray) -> list[dict[str, Any]]:
    """`tiered.analyze` on the mask `tiered.birefnet_mask` makes from `alpha_full`.

    The real `birefnet_mask` runs with `predict_alpha` stubbed to return the
    given plane, so the crop-back, threshold and close are tiered's own.
    """
    import cv2

    from app.cropper import birefnet, tiered

    with mock.patch.object(birefnet, "predict_alpha", lambda _rgb: alpha_full):
        mask = tiered.birefnet_mask(work)
    lab = cv2.cvtColor(work, cv2.COLOR_BGR2LAB).astype(np.float32)
    return tiered.analyze(mask, work, tiered.border_bg_lab(lab))


def corners(comp: Mapping[str, Any]) -> np.ndarray:
    import cv2

    from app.cropper import tiered

    pts = comp["quad"] if comp.get("quad") is not None else cv2.boxPoints(comp["rect"])
    return tiered.order_quad(np.asarray(pts, dtype=np.float64))


def quad_problems(
    got: list[dict[str, Any]], want: list[dict[str, Any]], tol_px: float = QUAD_TOLERANCE_PX
) -> list[str]:
    """Same components, same routes, every corner within `tol_px`."""
    if len(got) != len(want):
        return [f"{len(got)} components != golden {len(want)}"]
    problems = []
    for i, (g, w) in enumerate(zip(got, want, strict=True)):
        if g["route"] != w["route"]:
            problems.append(f"component {i}: route {g['route']} != golden {w['route']}")
            continue
        dist = np.linalg.norm(corners(g) - corners(w), axis=1)
        if float(dist.max()) > tol_px:
            problems.append(
                f"component {i}: a corner moved {float(dist.max()):.2f} px (> {tol_px} px)"
            )
    return problems


# ── Reference copies the canaries perturb ───────────────────────────────────
#
# Each equals `birefnet.preprocess`/`postprocess` with its defaults (the suite
# asserts that on every fixture), and takes one argument per canary.


def reference_preprocess(
    img: Image.Image,
    resample: Image.Resampling = Image.Resampling.LANCZOS,
    mean_shift: float = 0.0,
) -> np.ndarray:
    from app.cropper import birefnet

    mean = [m + mean_shift for m in birefnet.MEAN]
    std = birefnet.STD
    im = np.array(img.convert("RGB").resize(birefnet.INPUT_SIZE, resample))
    im = im / max(np.max(im), 1e-6)
    tmp = np.zeros((im.shape[0], im.shape[1], 3))
    for c in range(3):
        tmp[:, :, c] = (im[:, :, c] - mean[c]) / std[c]
    return np.expand_dims(tmp.transpose((2, 0, 1)), 0).astype(np.float32)


def reference_postprocess(
    raw: np.ndarray, size: tuple[int, int], sigmoid: bool = True, scale: int = 255
) -> np.ndarray:
    with np.errstate(over="ignore", divide="ignore", invalid="ignore"):
        pred = raw[:, 0, :, :].astype(raw.dtype)
        if sigmoid:
            pred = 1 / (1 + np.exp(-pred))
        ma, mi = np.max(pred), np.min(pred)
        pred = np.squeeze((pred - mi) / (ma - mi))
        mask = Image.fromarray((pred * scale).astype("uint8"))
    return np.array(mask.resize(size, Image.Resampling.LANCZOS))


def alpha_plus_one(alpha: np.ndarray) -> np.ndarray:
    return np.minimum(alpha.astype(np.int16) + 1, 255).astype(np.uint8)


def env_defaults(environ: dict[str, str] | os._Environ[str]) -> None:
    """Offline, deterministic settings the job's image does not already set.

    rembg reads U2NET_HOME when it builds its session; pointing it at the
    verified original model means pooch finds the file (md5 checked) and
    never touches the network.
    """
    environ.setdefault("HF_HUB_OFFLINE", "1")
    environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    if environ.get(STAGE_ENV) == "oracle":
        environ.setdefault("NUMBA_DISABLE_JIT", "1")
        original = environ.get(ORIGINAL_MODEL_ENV)
        if original:
            environ.setdefault("U2NET_HOME", str(Path(original).parent))
