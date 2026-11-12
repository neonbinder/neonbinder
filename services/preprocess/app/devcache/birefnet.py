"""Cache B: BiRefNet alpha planes (NEO-484, on the direct-ORT path).

**Key** = sha256 over, joined with `|`:

    "nb-devcache/birefnet" | MASK_CACHE_FORMAT | canonical JSON fingerprint
    | sha256(padded_rgb.tobytes()) | shape | dtype

The input is the padded RGB array `tiered.pad_for_birefnet` builds, which is
exactly what `birefnet.predict_alpha` receives. The fingerprint names everything
else that decides the alpha (C decision 12): the implementation
(`INFERENCE_IMPL`), the transcribed pre/post-processing (`PRE_POST_SPEC`), the
model and the sha256 of its baked weights, the session options, the execution
providers, and the onnxruntime, Pillow and numpy versions. Versions are read
with `importlib.metadata`, so building a key never imports onnxruntime.

**No weights hash, no cache.** `birefnet.weights_sha256()` reads the hash file
the image bake writes beside the model; it is never computed at runtime. When
it is missing or malformed B is off for the request (no counter): a key that
cannot name the weights could serve a mask from different weights.

**Value** = the whole padded alpha plane as a lossless 8-bit PNG. Cropping to
the work frame, the `> 25` threshold and the morphological close always run
after the cache (`tiered.birefnet_mask`), so a change to any of them never
needs a new key.
"""

from __future__ import annotations

import hashlib
import json
from importlib import metadata
from io import BytesIO
from typing import Any, Final

import numpy as np
from PIL import Image

from app.cropper import birefnet
from app.devcache import store

KIND: Final[str] = "birefnet"
KEY_NAMESPACE: Final[str] = "nb-devcache/birefnet"
MASK_CACHE_FORMAT: Final[int] = 1
VERSION_DISTS: Final[tuple[str, ...]] = ("onnxruntime", "Pillow", "numpy")


def _versions() -> dict[str, str]:
    return {dist: metadata.version(dist) for dist in VERSION_DISTS}


def fingerprint() -> dict[str, Any] | None:
    """Everything besides the input that decides the alpha; None when B is off."""
    weights = birefnet.weights_sha256()
    if weights is None:
        return None
    return {
        "impl": birefnet.INFERENCE_IMPL,
        "pre_post": birefnet.PRE_POST_SPEC,
        "model": birefnet.model_name(),
        "weights_sha256": weights,
        "session_options": birefnet.session_options_spec(),
        "providers": list(birefnet.PROVIDERS),
        "versions": _versions(),
    }


def fingerprint_json() -> str | None:
    """`fingerprint()` as canonical JSON (sorted keys, no spaces), or None."""
    fp = fingerprint()
    if fp is None:
        return None
    return json.dumps(fp, sort_keys=True, separators=(",", ":"))


def cache_key(padded_rgb: np.ndarray) -> str:
    """The key for one padded input. Raises `store.CacheOff` when B is off."""
    fp = fingerprint_json()
    if fp is None:
        raise store.CacheOff("no BiRefNet weights hash")
    parts = (
        KEY_NAMESPACE,
        str(MASK_CACHE_FORMAT),
        fp,
        hashlib.sha256(padded_rgb.tobytes()).hexdigest(),
        "x".join(str(d) for d in padded_rgb.shape),
        padded_rgb.dtype.str,
    )
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def encode_alpha(alpha: np.ndarray) -> bytes:
    """A uint8 HxW alpha plane as PNG bytes (lossless)."""
    if alpha.ndim != 2 or alpha.dtype != np.uint8:
        raise ValueError(f"alpha must be uint8 HxW, got {alpha.dtype} {alpha.shape}")
    out = BytesIO()
    Image.fromarray(alpha).save(out, format="PNG")
    return out.getvalue()


def decode_alpha(payload: bytes, shape_hw: tuple[int, int]) -> np.ndarray:
    """PNG bytes back to a uint8 HxW plane; rejects anything but an "L" PNG of `shape_hw`.

    Format, mode and size come from the PNG header, so all three are checked
    before `np.array` decodes any pixel data: a payload declaring huge
    dimensions is refused without allocating them.
    """
    h, w = shape_hw
    with Image.open(BytesIO(payload)) as img:
        if img.format != "PNG" or img.mode != "L":
            raise ValueError("cached alpha is not an 8-bit grayscale PNG")
        if img.size != (w, h):
            raise ValueError("cached alpha has the wrong shape")
        alpha = np.array(img)
    if alpha.shape != shape_hw or alpha.dtype != np.uint8:
        raise ValueError("cached alpha has the wrong shape")
    return alpha


def lookup(padded_rgb: np.ndarray) -> tuple[np.ndarray | None, store.Slot | None]:
    """`(alpha, None)` on a hit, else `(None, slot_or_None)`. Never raises."""
    shape_hw = (int(padded_rgb.shape[0]), int(padded_rgb.shape[1]))
    return store.lookup(
        KIND,
        lambda: cache_key(padded_rgb),
        lambda payload: decode_alpha(payload, shape_hw),
    )


def remember(slot: store.Slot | None, alpha: np.ndarray) -> None:
    """Store a live alpha plane. Never raises; an unencodable plane is a write failure."""
    if slot is None:
        return
    try:
        payload = encode_alpha(alpha)
    except Exception as exc:  # noqa: BLE001 - never fail the request over the cache
        store.warn_limited(KIND, "encode", exc)
        store.count("cache_write_failures")
        return
    slot.save(payload)
