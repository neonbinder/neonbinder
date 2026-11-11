"""BiRefNet background matte through onnxruntime directly (NEO-484, option C).

This module replaces rembg on the runtime path. rembg pulled in pymatting,
whose numba compile cost ~100 s of every heavy cold start, for an alpha-
matting step this service never uses (`alpha_matting=False`). What rembg
actually did for us is about fifteen lines of numpy and Pillow, transcribed
here literally from rembg 2.0.78:

  - `preprocess`   = `BaseSession.normalize` with BiRefNet's mean, std and
                     1024x1024 size (float64 arithmetic, then float32).
  - `postprocess`  = the tail of `BiRefNetSessionGeneral.predict`: sigmoid of
                     channel 0, min-max normalise, `*255` truncated to uint8,
                     mode "L", LANCZOS back to the input size.
  - `predict_alpha` = `predict` plus `naive_cutout`, whose alpha channel equals
                     the mask, so the mask itself is returned.

Do not "improve" any of it. A float32 shortcut, another resampling filter or a
rounding cast changes masks, and the masks feed benchmark-tuned geometry
(`tiered.py`). The golden-mask parity job (`tests/parity/`) proves this file
byte-identical to rembg 2.0.78 on every PR; change the transcription only
together with the goldens and `INFERENCE_IMPL`.

The session is created once per process behind a lock, from a model that was
pre-optimised at ORT_ENABLE_EXTENDED at image build (`scripts/bake_birefnet.py`)
and is loaded here at ORT_ENABLE_ALL. Never set `optimized_model_filepath` at
runtime, and never load at ORT_DISABLE_ALL (masks drift). The bake writes a
provenance JSON next to the model; `get_session` refuses a model baked by a
different onnxruntime version.

Importing this module never imports onnxruntime: the FAST role and the unit
suite import it for free, and only `get_session` pays the ORT import.

Portions of this file are derived from rembg 2.0.78
(https://github.com/danielgatis/rembg), used under the MIT License:

    MIT License

    Copyright (c) 2020 Daniel Gatis

    Permission is hereby granted, free of charge, to any person obtaining a
    copy of this software and associated documentation files (the
    "Software"), to deal in the Software without restriction, including
    without limitation the rights to use, copy, modify, merge, publish,
    distribute, sublicense, and/or sell copies of the Software, and to permit
    persons to whom the Software is furnished to do so, subject to the
    following conditions:

    The above copyright notice and this permission notice shall be included
    in all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
    OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
    MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
    NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
    DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
    OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
    USE OR OTHER DEALINGS IN THE SOFTWARE.
"""

from __future__ import annotations

import itertools
import json
import logging
import os
import re
import threading
import time
from importlib import metadata
from typing import Any, Final

import numpy as np
from PIL import Image

from app.timing import timing_logger

logger = logging.getLogger(__name__)

# ── Identity (part of the NEO-484 B cache fingerprint) ──────────────────────

# Names this implementation. Bump the trailing version whenever the
# pre/post-processing or session construction changes in a way that can change
# a mask, so cached masks from the old code can never be served.
INFERENCE_IMPL: Final[str] = "birefnet-direct-ort/rembg-2.0.78-predict/v1"

# CPU only. The image has no GPU and must never pick an EP by probing.
PROVIDERS: Final[tuple[str, ...]] = ("CPUExecutionProvider",)

MODEL_ENV: Final[str] = "BIREFNET_MODEL"
HOME_ENV: Final[str] = "BIREFNET_HOME"
DEFAULT_MODEL: Final[str] = "birefnet-general"
DEFAULT_HOME: Final[str] = "/opt/birefnet"

# Only the BiRefNet family may be selected. The env var only ever chooses
# between two local files, but the allowlist keeps a typo from becoming a path.
ALLOWED_MODELS: Final[frozenset[str]] = frozenset({"birefnet-general", "birefnet-general-lite"})

SHA256_SUFFIX: Final[str] = ".sha256"
PROVENANCE_SUFFIX: Final[str] = ".provenance.json"
PROVENANCE_FORMAT: Final[int] = 1

# rembg 2.0.78 `BiRefNetSessionGeneral.predict` constants.
INPUT_SIZE: Final[tuple[int, int]] = (1024, 1024)
MEAN: Final[tuple[float, float, float]] = (0.485, 0.456, 0.406)
STD: Final[tuple[float, float, float]] = (0.229, 0.224, 0.225)

# rembg sets this once at import (`rembg/bg.py`): warnings and info off.
ORT_LOGGER_SEVERITY: Final[int] = 3
GRAPH_OPTIMIZATION_LEVEL: Final[str] = "ORT_ENABLE_ALL"
# Intra-op threads per inference (NEO-484, Jason 2026-11-10). gen2 reports 5-6
# CPUs against a 4-vCPU quota, so ORT's default (one thread per reported CPU)
# oversubscribed. Measured on 16 gen2 tasks: masks bit-identical to the default
# and to the parity goldens on every host class, and 14-15% faster on Intel
# 2.0 GHz and Milan. Only intra-op was measured; inter-op keeps the rembg rule.
INTRA_OP_NUM_THREADS: Final[int] = 4

# A canonical description of what `preprocess`/`postprocess` do, for the cache
# fingerprint. A string (canonical JSON) so it is immutable and hashes as-is.
PRE_POST_SPEC: Final[str] = json.dumps(
    {
        "spec": 1,
        "source": "rembg==2.0.78 BaseSession.normalize + BiRefNetSessionGeneral.predict "
        "+ naive_cutout alpha",
        "pre": {
            "convert": "RGB",
            "resize": list(INPUT_SIZE),
            "resample": "LANCZOS",
            "scale": "x / max(max(x), 1e-6)",
            "mean": list(MEAN),
            "std": list(STD),
            "arith": "float64",
            "layout": "NCHW",
            "cast": "float32",
        },
        "post": {
            "channel": 0,
            "activation": "sigmoid",
            "normalize": "minmax",
            "scale": 255,
            "cast": "uint8 truncate",
            "mode": "L",
            "resize": "LANCZOS to input size",
        },
        "alpha": "mask",
    },
    sort_keys=True,
    separators=(",", ":"),
)

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

# ── Model selection ─────────────────────────────────────────────────────────


def model_name() -> str:
    """The BiRefNet model this process uses, from `BIREFNET_MODEL`.

    Read on every call so tests and deploys can steer it without re-importing.
    Raises ValueError for anything outside `ALLOWED_MODELS`.
    """
    name = os.environ.get(MODEL_ENV, DEFAULT_MODEL)
    if name not in ALLOWED_MODELS:
        raise ValueError(
            f"{MODEL_ENV} {name!r} is not allowed; choose one of {sorted(ALLOWED_MODELS)}"
        )
    return name


def model_path() -> str:
    """Absolute path of the baked, pre-optimised model: `$BIREFNET_HOME/<model>.onnx`."""
    return os.path.join(os.environ.get(HOME_ENV, DEFAULT_HOME), f"{model_name()}.onnx")


def weights_sha256() -> str | None:
    """The sha256 the bake recorded for the model file (`<model>.onnx.sha256`).

    Lowercase hex, or None when the file is missing or malformed. None turns
    the B mask cache off; it never fails a request. The model itself is never
    hashed at runtime (930 MB would add seconds to a cold start).
    """
    try:
        with open(model_path() + SHA256_SUFFIX, encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return None
    # Accept both a bare digest and `sha256sum` output ("<hex>  <file>").
    token = text.strip().split()[0].lower() if text.strip() else ""
    return token if _SHA256_RE.match(token) else None


def _omp_threads() -> int:
    """rembg's `new_session` OMP_NUM_THREADS rule: the value, else ORT's default (0).

    rembg applied it to both thread pools; here it sets only inter-op, since
    intra-op is pinned to `INTRA_OP_NUM_THREADS`. A malformed value raises, as
    it did in rembg.
    """
    raw = os.environ.get("OMP_NUM_THREADS")
    return int(raw) if raw is not None else 0


def session_options_spec() -> dict[str, Any]:
    """The ORT session options `get_session` applies, as plain data.

    Pure (no onnxruntime import), so the cache fingerprint and the parity
    suite can read it without loading a session.

    - The CPU memory arena is off: with it, ORT kept every inference's peak
      allocation for the process lifetime (~8 GB after one pass), which
      OOM-killed an 8Gi container on its first real request.
    - Intra-op threads are pinned to `INTRA_OP_NUM_THREADS` (4), whatever
      OMP_NUM_THREADS says; inter-op keeps rembg's OMP_NUM_THREADS rule.
      The dict feeds the B cache key, so a change here starts the cache over.
    """
    return {
        "enable_cpu_mem_arena": False,
        "graph_optimization_level": GRAPH_OPTIMIZATION_LEVEL,
        "intra_op_num_threads": INTRA_OP_NUM_THREADS,
        "inter_op_num_threads": _omp_threads(),
        "logger_severity": ORT_LOGGER_SEVERITY,
    }


# ── Session (lazy, cached, one factory) ─────────────────────────────────────

_session: Any = None
_session_lock = threading.Lock()
_run_counter = itertools.count(1)


def _build_session_options(ort: Any) -> Any:
    """An `ort.SessionOptions` carrying `session_options_spec()`.

    `optimized_model_filepath` is deliberately never set: saving at runtime
    re-optimises for this host's CPU, and a model saved at ALL crashes on
    another CPU.
    """
    spec = session_options_spec()
    opts = ort.SessionOptions()
    opts.enable_cpu_mem_arena = spec["enable_cpu_mem_arena"]
    opts.graph_optimization_level = getattr(
        ort.GraphOptimizationLevel, spec["graph_optimization_level"]
    )
    opts.intra_op_num_threads = spec["intra_op_num_threads"]
    opts.inter_op_num_threads = spec["inter_op_num_threads"]
    return opts


def _check_provenance(path: str, ort_version: str) -> dict[str, Any]:
    """Refuse a model the bake did not produce for this onnxruntime and model.

    The bake pre-optimises at EXTENDED with the ORT in the image; an image
    rebuilt with another ORT but an old model layer would load a graph that
    ORT did not optimise, so a mismatch raises instead of serving drifted
    masks. Returns the parsed provenance.
    """
    prov_path = path + PROVENANCE_SUFFIX
    try:
        with open(prov_path, encoding="utf-8") as fh:
            prov = json.load(fh)
    except (OSError, ValueError) as exc:
        raise RuntimeError(f"BiRefNet provenance missing or unreadable: {prov_path}") from exc
    if not isinstance(prov, dict) or prov.get("format") != PROVENANCE_FORMAT:
        raise RuntimeError(f"BiRefNet provenance has an unknown format: {prov_path}")
    if prov.get("onnxruntime") != ort_version:
        raise RuntimeError(
            f"BiRefNet model was baked with onnxruntime {prov.get('onnxruntime')!r} "
            f"but {ort_version!r} is installed; rebuild the image"
        )
    if prov.get("model") != model_name():
        raise RuntimeError(
            f"BiRefNet provenance is for model {prov.get('model')!r}, not {model_name()!r}"
        )
    return prov


def _new_inference_session(path: str, sess_options: Any, providers: list[str]) -> Any:
    """The one place an `ort.InferenceSession` is constructed.

    The unit-suite conftest blocks this so no test can load a real model.
    """
    import onnxruntime as ort

    return ort.InferenceSession(path, sess_options=sess_options, providers=providers)


def _create_session() -> Any:
    import onnxruntime as ort

    ort.set_default_logger_severity(ORT_LOGGER_SEVERITY)
    path = model_path()
    _check_provenance(path, ort.__version__)
    opts = _build_session_options(ort)
    logger.info("loading BiRefNet session %s (direct ORT, cpu_mem_arena off)", model_name())
    return _new_inference_session(path, opts, list(PROVIDERS))


def get_session() -> Any:
    """Create (once) and return the ORT session.

    Cached for the container's lifetime behind a lock: three concurrent cold
    requests must not each construct a ~930 MB session.
    """
    global _session
    if _session is None:
        with _session_lock:
            if _session is None:
                _session = _create_session()
    return _session


def is_session_loaded() -> bool:
    """Cheap, side-effect-free: is the session already resident in this process?"""
    return _session is not None


def load_session() -> dict[str, Any]:
    """Load the session now (the heavy role's startup hook) and report it.

    Returns `{session_load_s, model, ort}`. `session_load_s` is 0.0 when the
    session was already resident. No inference runs: the input shape is fixed
    at 1024, so a small dummy cannot warm anything, and the first real run is
    only a few seconds slower than later ones.
    """
    started = time.perf_counter()
    get_session()
    return {
        "session_load_s": round(time.perf_counter() - started, 3),
        "model": model_name(),
        "ort": metadata.version("onnxruntime"),
    }


# ── Pre/post-processing (rembg 2.0.78, transcribed) ─────────────────────────


def preprocess(img: Image.Image) -> np.ndarray:
    """rembg `BaseSession.normalize` for BiRefNet: a (1, 3, 1024, 1024) float32 tensor.

    The division and the mean/std step run in float64 (numpy's promotion of
    uint8 by a Python float) and only the final tensor is float32. An all-black
    image divides by 1e-6 instead of 0.
    """
    im = img.convert("RGB").resize(INPUT_SIZE, Image.Resampling.LANCZOS)

    im_ary = np.array(im)
    im_ary = im_ary / max(np.max(im_ary), 1e-6)

    tmp_img = np.zeros((im_ary.shape[0], im_ary.shape[1], 3))
    tmp_img[:, :, 0] = (im_ary[:, :, 0] - MEAN[0]) / STD[0]
    tmp_img[:, :, 1] = (im_ary[:, :, 1] - MEAN[1]) / STD[1]
    tmp_img[:, :, 2] = (im_ary[:, :, 2] - MEAN[2]) / STD[2]

    tmp_img = tmp_img.transpose((2, 0, 1))

    return np.expand_dims(tmp_img, 0).astype(np.float32)


def _sigmoid(mat: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-mat))


def postprocess(raw: np.ndarray, size: tuple[int, int]) -> Image.Image:
    """The tail of rembg `BiRefNetSessionGeneral.predict`: raw logits to an "L" mask.

    `raw` is the model's first output, (1, C, 1024, 1024); only channel 0 is
    read. `size` is PIL's (width, height) of the image that was preprocessed.
    The `* 255` cast truncates, as rembg's `astype("uint8")` does.

    `errstate` only silences numpy's warnings (overflow in exp, 0/0 on a
    constant output); it changes no value. rembg's `mode="L"` argument is
    dropped because Pillow deprecates it: `fromarray` of a 2-D uint8 array is
    mode "L" with the same bytes.
    """
    with np.errstate(over="ignore", divide="ignore", invalid="ignore"):
        pred = _sigmoid(raw[:, 0, :, :])

        ma = np.max(pred)
        mi = np.min(pred)

        pred = (pred - mi) / (ma - mi)
        pred = np.squeeze(pred)

        mask = Image.fromarray((pred * 255).astype("uint8"))
    return mask.resize(size, Image.Resampling.LANCZOS)


def predict_alpha(rgb: np.ndarray) -> np.ndarray:
    """BiRefNet alpha for an RGB uint8 HxWx3 array: a uint8 HxW array.

    Equals `rembg.remove(rgb, session=...)[..., 3]` for rembg 2.0.78 with
    alpha matting off: `remove` builds the image with `Image.fromarray`,
    `exif_transpose` is a no-op on it (no EXIF), and `naive_cutout`'s alpha is
    the mask. Logs one `birefnet_run` JSON line with the stage timings.
    """
    if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.dtype != np.uint8:
        raise ValueError(f"predict_alpha needs uint8 HxWx3, got {rgb.dtype} {rgb.shape}")
    session = get_session()

    t0 = time.perf_counter()
    img = Image.fromarray(rgb)
    tensor = preprocess(img)
    t1 = time.perf_counter()
    ort_outs = session.run(None, {session.get_inputs()[0].name: tensor})
    if (
        __import__("os").environ.get("PARITY_STAGE")
        or "PYTEST_CURRENT_TEST" not in __import__("os").environ
    ):
        raise RuntimeError("NEO484-THROW-B")  # T1, revert before merge
    t2 = time.perf_counter()
    mask = postprocess(ort_outs[0], img.size)
    alpha = np.array(mask)
    t3 = time.perf_counter()

    timing_logger.info(
        json.dumps(
            {
                "msg": "birefnet_run",
                "n": next(_run_counter),
                "pre_ms": round((t1 - t0) * 1000.0, 1),
                "ort_ms": round((t2 - t1) * 1000.0, 1),
                "post_ms": round((t3 - t2) * 1000.0, 1),
            },
            separators=(",", ":"),
        )
    )
    return alpha
