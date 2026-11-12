#!/usr/bin/env python3
"""Bake the BiRefNet model into the image (NEO-484, option C). Runs at docker build.

Steps, each one fatal on failure:

1. Download rembg 2.0.78's original model for `$BIREFNET_MODEL` from rembg's
   release URL (or take `--source` for an offline build) and verify both
   rembg's pinned md5 and our pinned sha256.
2. Save a graph pre-optimised at ORT_ENABLE_EXTENDED. Never at ORT_ENABLE_ALL:
   an ALL-saved graph carries this build host's CPU-specific kernels and
   crashes on another CPU. Runtime loads the EXTENDED file at ENABLE_ALL.
3. Self-check: load the original and the optimised file, each at
   ORT_ENABLE_ALL with the arena off (the runtime settings), run one
   synthetic 1024x1024 input through each, and require byte-equal raw
   output. A mismatch fails the build: a rebuilt image must never serve
   masks that differ from the model rembg shipped.
4. Delete the original, then write `<model>.onnx.sha256` (read by the B mask
   cache) and `<model>.onnx.provenance.json` (checked by
   `birefnet.get_session`, which refuses a model baked by another ORT).

The Dockerfile makes the directory read-only in the same RUN, so the model
is never a writable layer. Usage:

    python scripts/bake_birefnet.py [--model NAME] [--home DIR] [--source FILE]
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

# Kept in step with app.cropper.birefnet without importing it (the bake runs
# before `app/` is copied into the image, and must not depend on it).
PROVENANCE_FORMAT = 1
PROVENANCE_SUFFIX = ".provenance.json"
SHA256_SUFFIX = ".sha256"
SAVE_LEVEL = "ORT_ENABLE_EXTENDED"
LOAD_LEVEL = "ORT_ENABLE_ALL"
FORBIDDEN_SAVE_LEVEL = "ORT_ENABLE_ALL"
PROVIDERS = ["CPUExecutionProvider"]
INPUT_SHAPE = (1, 3, 1024, 1024)
SELF_CHECK_SEED = 484

# rembg 2.0.78's source for each allowed model: its release URL, its pooch md5
# (rembg/sessions/*.py), and the sha256 we pinned. birefnet-general's sha256
# was captured from the deployed image in S0a; the lite one from rembg's
# release file. Change a pin only together with the parity goldens.
SOURCES: dict[str, dict[str, str]] = {
    "birefnet-general": {
        "url": "https://github.com/danielgatis/rembg/releases/download/v0.0.0/"
        "BiRefNet-general-epoch_244.onnx",
        "md5": "7a35a0141cbbc80de11d9c9a28f52697",
        "sha256": "58f621f00f5d756097615970a88a791584600dcf7c45b18a0a6267535a1ebd3c",
    },
    "birefnet-general-lite": {
        "url": "https://github.com/danielgatis/rembg/releases/download/v0.0.0/"
        "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
        "md5": "4fab47adc4ff364be1713e97b7e66334",
        "sha256": "5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333",
    },
}


class BakeError(RuntimeError):
    """The bake must stop; the image would otherwise ship an unverified model."""


def _log(msg: str) -> None:
    print(f"bake_birefnet: {msg}", flush=True)


def file_hashes(path: Path) -> dict[str, Any]:
    sha = hashlib.sha256()
    md5 = hashlib.md5()  # noqa: S324 - rembg's pinned checksum, not security
    size = 0
    with open(path, "rb") as fh:
        while chunk := fh.read(8 << 20):
            sha.update(chunk)
            md5.update(chunk)
            size += len(chunk)
    return {"sha256": sha.hexdigest(), "md5": md5.hexdigest(), "bytes": size}


def verify(path: Path, md5: str, sha256: str) -> dict[str, Any]:
    """Both pinned hashes must match; returns the file's hashes."""
    got = file_hashes(path)
    if got["md5"] != md5:
        raise BakeError(f"{path.name}: md5 {got['md5']} != pinned {md5}")
    if got["sha256"] != sha256:
        raise BakeError(f"{path.name}: sha256 {got['sha256']} != pinned {sha256}")
    return got


def download(url: str, dest: Path, timeout: float = 120.0) -> None:
    """Stream `url` to `dest` (no partial file left behind on failure)."""
    part = dest.with_suffix(dest.suffix + ".part")
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp, open(part, "wb") as out:  # noqa: S310
            shutil.copyfileobj(resp, out, 8 << 20)
        part.replace(dest)
    finally:
        part.unlink(missing_ok=True)


def session_options(ort: Any, level: str, save_to: Path | None = None) -> Any:
    if save_to is not None and level == FORBIDDEN_SAVE_LEVEL:
        raise BakeError("never save a model at ORT_ENABLE_ALL (host-specific kernels)")
    opts = ort.SessionOptions()
    opts.enable_cpu_mem_arena = False
    opts.graph_optimization_level = getattr(ort.GraphOptimizationLevel, level)
    if save_to is not None:
        opts.optimized_model_filepath = str(save_to)
    return opts


def optimize(ort: Any, src: Path, dst: Path) -> None:
    """Write `dst`: `src` pre-optimised at ORT_ENABLE_EXTENDED."""
    session = ort.InferenceSession(
        str(src), sess_options=session_options(ort, SAVE_LEVEL, dst), providers=PROVIDERS
    )
    del session
    gc.collect()
    if not dst.is_file() or dst.stat().st_size == 0:
        raise BakeError(f"onnxruntime did not write the optimised model to {dst}")


def synthetic_input() -> np.ndarray:
    """A fixed, image-like (1, 3, 1024, 1024) float32 tensor."""
    rng = np.random.default_rng(SELF_CHECK_SEED)
    return rng.standard_normal(INPUT_SHAPE).astype(np.float32)


def _raw_output(ort: Any, model: Path, x: np.ndarray) -> np.ndarray:
    session = ort.InferenceSession(
        str(model), sess_options=session_options(ort, LOAD_LEVEL), providers=PROVIDERS
    )
    try:
        out = session.run(None, {session.get_inputs()[0].name: x})[0]
        return np.array(out, copy=True)
    finally:
        del session
        gc.collect()


def self_check(ort: Any, original: Path, optimised: Path) -> dict[str, Any]:
    """Original and optimised, both at ENABLE_ALL, must give byte-equal raw output.

    One session at a time, so the build's peak memory is one inference.
    """
    x = synthetic_input()
    t0 = time.perf_counter()
    a = _raw_output(ort, original, x)
    b = _raw_output(ort, optimised, x)
    if a.dtype != b.dtype or a.shape != b.shape or a.tobytes() != b.tobytes():
        diff = float(np.max(np.abs(a.astype(np.float64) - b.astype(np.float64))))
        raise BakeError(
            f"self-check failed: optimised output differs from the original (max |d| {diff})"
        )
    return {
        "input": f"rng({SELF_CHECK_SEED}).standard_normal{list(INPUT_SHAPE)} float32",
        "level": LOAD_LEVEL,
        "output_sha256": hashlib.sha256(a.tobytes()).hexdigest(),
        "seconds": round(time.perf_counter() - t0, 1),
    }


def bake(
    model: str,
    home: Path,
    ort: Any,
    source: Path | None = None,
    fetch: Callable[[str, Path], None] = download,
) -> dict[str, Any]:
    """Run every step; returns the provenance written beside the model."""
    if model not in SOURCES:
        raise BakeError(f"unknown model {model!r}; choose one of {sorted(SOURCES)}")
    pin = SOURCES[model]
    home.mkdir(parents=True, exist_ok=True)
    final = home / f"{model}.onnx"
    with tempfile.TemporaryDirectory(prefix="bake-", dir=home) as tmp:
        tmpdir = Path(tmp)
        original = tmpdir / f"{model}.original.onnx"
        if source is not None:
            shutil.copyfile(source, original)
        else:
            _log(f"downloading {pin['url']}")
            fetch(pin["url"], original)
        src_hashes = verify(original, pin["md5"], pin["sha256"])
        _log(f"source verified: sha256 {src_hashes['sha256']}")

        optimised = tmpdir / f"{model}.onnx"
        optimize(ort, original, optimised)
        check = self_check(ort, original, optimised)
        _log(f"self-check passed in {check['seconds']}s")

        original.unlink()
        optimised.replace(final)

    out_hashes = file_hashes(final)
    (home / f"{model}.onnx{SHA256_SUFFIX}").write_text(f"{out_hashes['sha256']}  {final.name}\n")
    provenance = {
        "format": PROVENANCE_FORMAT,
        "model": model,
        "onnxruntime": ort.__version__,
        "saved_at": SAVE_LEVEL,
        "load_at": LOAD_LEVEL,
        "source_url": pin["url"],
        "source_md5": src_hashes["md5"],
        "source_sha256": src_hashes["sha256"],
        "source_bytes": src_hashes["bytes"],
        "sha256": out_hashes["sha256"],
        "bytes": out_hashes["bytes"],
        "self_check": check,
    }
    (home / f"{model}.onnx{PROVENANCE_SUFFIX}").write_text(
        json.dumps(provenance, indent=2, sort_keys=True) + "\n"
    )
    _log(f"baked {final} ({out_hashes['bytes']} bytes, sha256 {out_hashes['sha256']})")
    return provenance


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--model", default=os.environ.get("BIREFNET_MODEL", "birefnet-general"))
    ap.add_argument(
        "--home", type=Path, default=Path(os.environ.get("BIREFNET_HOME", "/opt/birefnet"))
    )
    ap.add_argument("--source", type=Path, help="a local copy of the original model")
    args = ap.parse_args(argv)

    import onnxruntime as ort

    ort.set_default_logger_severity(3)
    try:
        bake(args.model, args.home, ort, source=args.source)
    except BakeError as exc:
        print(f"bake_birefnet: FAILED: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
