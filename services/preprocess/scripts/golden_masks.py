#!/usr/bin/env python3
"""Golden BiRefNet masks for the NEO-484 parity suite.

Run from `services/preprocess/` (or `/app` inside the image). The script
needs only the app's existing modules (`app.cropper.tiered`), numpy, Pillow
and OpenCV, so it runs unchanged inside the image deployed before NEO-484,
where `app.cropper.birefnet` does not exist yet:

  - `--impl rembg` never imports `app.cropper.birefnet`. It calls rembg the
    way the old `tiered.birefnet_mask` did.
  - `--impl direct` imports `app.cropper.birefnet` and calls `predict_alpha`.

Modes:

    generate --impl rembg|direct --fixtures DIR|gs://BUCKET[/PREFIX] --out DIR|gs://...
        Decode each fixture with `tiered._load`, pad it exactly as
        `tiered.birefnet_mask` does, and write the full padded alpha plane as
        a lossless PNG per fixture plus `manifest.json` (format 1). `--out`
        may hold `{exec_env}`, `{task}` and `{run}` so several instances or
        job tasks never write over each other. `--serve` answers HTTP on
        $PORT while it works, for a Cloud Run service.

    hash RUN_DIR [RUN_DIR ...] --out DIR [--goldens-from RUN_DIR] [--tolerance T,F,N]
        Re-hash every run's PNGs, check the runs saw the same inputs, and
        merge them into one goldens manifest: per fixture, one alpha hash per
        host fingerprint. Copies the PNGs of one run (default: the first).
        Two runs on the same fingerprint that disagree is an error.

    compare A B [C ...] [--tolerance T,F,N] [--report-only]
        Compare each directory's PNGs with A's. Prints per-fixture and
        overall differences, and the tolerance the plan derives from them
        (2x the maximum). Exit 0 when exact or within tolerance, 1 when not,
        2 when the inputs differ (a different fixture or padding).

    fingerprint [--impl rembg|direct]
        Print this host's fingerprint and installed packages. No inference.

Tolerance (T, F, N), each the worst over every fixture:
  T  the largest absolute alpha difference at any pixel;
  F  the fraction of alpha pixels that differ (any amount);
  N  the pixels that differ in the BINARY mask tiered builds from the alpha
     (crop back to the work frame, alpha > 25, 5x5 elliptical close), which
     is what reaches the geometry. The alpha pixel count is reported beside
     it but is not N: a 1-level alpha change rarely flips a mask pixel.
"""

from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import os
import platform
import re
import shutil
import sys
import tempfile
import threading
import time
import uuid
from collections.abc import Iterable, Mapping
from importlib import metadata
from pathlib import Path
from typing import Any

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

MANIFEST_FORMAT = 1
MANIFEST_NAME = "manifest.json"
FIXTURE_EXTS = (".jpg", ".jpeg", ".png", ".webp")
IMPLS = ("rembg", "direct")

# The ring the padding colour is measured on, as in `tiered.birefnet_mask`.
RING_FRAC = 0.03

# rembg 2.0.78's pinned md5 for each source model (its pooch checksums).
REMBG_MODEL_MD5 = {
    "birefnet-general": "7a35a0141cbbc80de11d9c9a28f52697",
    "birefnet-general-lite": "4fab47adc4ff364be1713e97b7e66334",
}
DEFAULT_MODEL = "birefnet-general"

# CPU features that pick different onnxruntime (MLAS) float kernels. Listed in
# a fixed order so the ISA string is stable.
RELEVANT_CPU_FLAGS = (
    "sse4_1",
    "avx",
    "f16c",
    "fma",
    "avx2",
    "avx_vnni",
    "avx512f",
    "avx512bw",
    "avx512dq",
    "avx512vl",
    "avx512_vnni",
    "avx512_bf16",
    "avx512_fp16",
    "amx_tile",
    "amx_bf16",
)

# Packages whose versions are part of the host fingerprint.
FINGERPRINT_PACKAGES = ("onnxruntime", "Pillow", "numpy", "opencv-python-headless")

# The plan's stop line for the derived tolerance: above any of these, ask Jason.
STOP_LINE = {"max_alpha_diff": 8, "max_alpha_pixel_frac": 0.002, "max_mask_pixels": 100}

# The binary mask `tiered.birefnet_mask` makes from the alpha, for N. A unit
# test pins these to tiered's own.
MASK_THRESHOLD = 25
MASK_CLOSE_KERNEL = 5


class InputMismatchError(Exception):
    """Two runs did not see the same input (fixture bytes, shape or padding)."""


# ── Padding (exactly as tiered.birefnet_mask) ───────────────────────────────


def pad_for_birefnet(work: np.ndarray) -> tuple[np.ndarray, int]:
    """Pad a BGR work image with its border-median colour; return (padded RGB, pad).

    A line-for-line copy of the padding in `tiered.birefnet_mask` as deployed
    before NEO-484, so the script runs in that image. When the app has its own
    `tiered.pad_for_birefnet`, `generate` checks the two agree on every fixture.
    """
    import cv2

    from app.cropper import tiered

    h, w = work.shape[:2]
    p = int(tiered.BIREFNET_PAD * max(h, w))
    t = max(2, int(RING_FRAC * min(h, w)))
    ring = np.concatenate(
        [
            work[:t].reshape(-1, 3),
            work[-t:].reshape(-1, 3),
            work[:, :t].reshape(-1, 3),
            work[:, -t:].reshape(-1, 3),
        ]
    )
    bg_bgr = tuple(int(v) for v in np.median(ring, axis=0))
    padded = cv2.copyMakeBorder(work, p, p, p, p, cv2.BORDER_CONSTANT, value=bg_bgr)
    return cv2.cvtColor(padded, cv2.COLOR_BGR2RGB), p


def _padded_input(work: np.ndarray) -> tuple[np.ndarray, int]:
    padded, p = pad_for_birefnet(work)
    from app.cropper import tiered

    # Both sides are RGB: the script's copy converts BGR->RGB last, as
    # `tiered.pad_for_birefnet` does, so a channel-order slip fails here too.
    # Absent in the pre-NEO-484 image, where the script's copy is the only one.
    app_pad = getattr(tiered, "pad_for_birefnet", None)
    if app_pad is not None:
        other, other_p = app_pad(work)
        if other_p != p or not np.array_equal(other, padded):
            raise InputMismatchError("tiered.pad_for_birefnet disagrees with the script's padding")
    return padded, p


# ── Host fingerprint ────────────────────────────────────────────────────────


def parse_cpuinfo(text: str) -> dict[str, Any]:
    """`{cpu_model, flags}` from /proc/cpuinfo text (first processor's values)."""
    cpu_model = "unknown"
    flags: set[str] = set()
    for line in text.splitlines():
        key, sep, value = line.partition(":")
        if not sep:
            continue
        key = key.strip()
        if key == "model name" and cpu_model == "unknown":
            cpu_model = " ".join(value.split())
        elif key in ("flags", "Features") and not flags:
            flags = set(value.split())
    return {"cpu_model": cpu_model, "flags": flags}


def isa_from(machine: str, flags: Iterable[str]) -> str:
    """`<machine>+flag+flag...` over RELEVANT_CPU_FLAGS, in their fixed order."""
    present = set(flags)
    return "+".join([machine, *[f for f in RELEVANT_CPU_FLAGS if f in present]])


# gVisor (Cloud Run gen1) names itself in /proc/version, e.g. "4.19.0-gvisor";
# older gVisor releases reported a bare 4.4.0 kernel instead.
_GVISOR_KERNEL = re.compile(r"gvisor|Linux version 4\.4\.0\b", re.IGNORECASE)


def exec_env_from(proc_version: str, environ: Mapping[str, str]) -> str:
    """`gen1` (a gVisor kernel), `gen2` (any other Cloud Run kernel), or `local`."""
    if _GVISOR_KERNEL.search(proc_version or ""):
        return "gen1"
    if environ.get("K_SERVICE") or environ.get("CLOUD_RUN_JOB"):
        return "gen2"
    return "local"


def _read(path: str) -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


def _nproc() -> int:
    try:
        return len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        return os.cpu_count() or 0


def _version(dist: str) -> str | None:
    try:
        return metadata.version(dist)
    except metadata.PackageNotFoundError:
        return None


def installed_packages() -> dict[str, str]:
    """The `pip freeze` of this interpreter, as {name: version}."""
    out: dict[str, str] = {}
    for dist in metadata.distributions():
        name = dist.metadata["Name"]
        if name:
            out[name] = dist.version
    return dict(sorted(out.items(), key=lambda kv: kv[0].lower()))


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


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def cpu_flags_digest(flags: Iterable[str]) -> str:
    """A short digest of the whole /proc/cpuinfo flag set.

    Tells CPU generations apart where `model name` is missing (gen1's gVisor
    cpuinfo has none). Empty when there are no flags (not Linux).
    """
    present = sorted(set(flags))
    if not present:
        return ""
    return hashlib.sha256(" ".join(present).encode()).hexdigest()[:12]


def fingerprint_key(fp: Mapping[str, Any]) -> str:
    """A short, order-independent id for a host fingerprint."""
    return hashlib.sha256(canonical_json(fp).encode()).hexdigest()[:16]


def model_info(impl: str) -> dict[str, Any]:
    """The model file this impl loads, its hashes, and the SOURCE model's hashes.

    The fingerprint keys on the source model (rembg's original download) so a
    direct run, which loads the EXTENDED-optimised file, shares a fingerprint
    with a rembg run of the same weights on the same host; the bake's
    self-check proves the two give byte-equal output.
    """
    if impl == "rembg":
        name = os.environ.get("REMBG_MODEL") or os.environ.get("BIREFNET_MODEL") or DEFAULT_MODEL
        default_home = os.path.join(os.environ.get("XDG_DATA_HOME", "~"), ".u2net")
        home = os.path.expanduser(os.environ.get("U2NET_HOME", default_home))
        path = Path(home) / f"{name}.onnx"
        hashes = file_hashes(path)
        expected = REMBG_MODEL_MD5.get(name)
        return {
            "name": name,
            "file": {"path": str(path), **hashes},
            "source": {"sha256": hashes["sha256"], "md5": hashes["md5"]},
            "md5_matches_rembg": expected == hashes["md5"],
        }
    from app.cropper import birefnet

    name = birefnet.model_name()
    path = Path(birefnet.model_path())
    hashes = file_hashes(path)
    prov_path = Path(str(path) + birefnet.PROVENANCE_SUFFIX)
    prov: dict[str, Any] = json.loads(prov_path.read_text()) if prov_path.exists() else {}
    source = {
        "sha256": prov.get("source_sha256") or hashes["sha256"],
        "md5": prov.get("source_md5") or hashes["md5"],
    }
    return {
        "name": name,
        "file": {"path": str(path), **hashes},
        "source": source,
        "provenance": prov or None,
        "md5_matches_rembg": REMBG_MODEL_MD5.get(name) == source["md5"],
    }


def _cpuinfo() -> dict[str, Any]:
    text = _read("/proc/cpuinfo")
    cpu = parse_cpuinfo(text)
    if not text:  # no /proc (a Mac): the only model name on offer
        cpu["cpu_model"] = platform.processor() or "unknown"
    return cpu


def host_fingerprint(model: Mapping[str, Any]) -> dict[str, Any]:
    """The fingerprint whose `fingerprint_key` must match for an exact comparison.

    {isa, exec_env, cpu_model, cpu_flags} + package versions + source model
    hashes. Only what can change the bits belongs here. `nproc` does not: on
    Cloud Run it follows the host (5, 8, 9 seen at 4 vCPU), not the vCPU limit,
    so it would stop keys recurring; it is recorded per run (`host_facts`).
    `cpu_model` stays "unknown" on gen1, where cpuinfo has no `model name`;
    `cpu_flags` tells hosts apart there.
    """
    cpu = _cpuinfo()
    machine = platform.machine() or "unknown"
    return {
        "isa": isa_from(machine, cpu["flags"]),
        "exec_env": exec_env_from(_read("/proc/version"), os.environ),
        "cpu_model": cpu["cpu_model"],
        "cpu_flags": cpu_flags_digest(cpu["flags"]),
        "omp_num_threads": os.environ.get("OMP_NUM_THREADS"),
        "versions": {pkg: _version(pkg) for pkg in FINGERPRINT_PACKAGES},
        "model": {"name": model["name"], **model["source"]},
    }


def host_facts() -> dict[str, Any]:
    """Recorded with each run but never part of the key."""
    return {
        "nproc": _nproc(),
        "cpu_flag_list": sorted(_cpuinfo()["flags"]),
        "proc_version": _read("/proc/version").strip(),
    }


# ── Inference back ends ─────────────────────────────────────────────────────


def _rembg_alpha_fn() -> tuple[Any, dict[str, Any]]:
    """rembg's alpha, with the session the old `tiered._get_session` built."""
    from rembg import remove

    from app.cropper import tiered

    get = getattr(tiered, "_get_session", None)
    if get is not None:
        session = get()
    else:  # the oracle layer, after tiered stopped importing rembg
        import onnxruntime as ort
        from rembg import new_session

        opts = ort.SessionOptions()
        opts.enable_cpu_mem_arena = False
        name = os.environ.get("REMBG_MODEL") or os.environ.get("BIREFNET_MODEL") or DEFAULT_MODEL
        session = new_session(name, sess_opts=opts)

    def alpha(rgb: np.ndarray) -> np.ndarray:
        return np.array(np.asarray(remove(rgb, session=session))[..., 3])

    info = {
        "inference_impl": f"rembg-{_version('rembg')}",
        "session": {"enable_cpu_mem_arena": False, "graph_optimization_level": "default"},
    }
    return alpha, info


def _direct_alpha_fn() -> tuple[Any, dict[str, Any]]:
    from app.cropper import birefnet

    info = {
        "inference_impl": birefnet.INFERENCE_IMPL,
        "pre_post_spec": birefnet.PRE_POST_SPEC,
        "session": birefnet.session_options_spec(),
        "providers": list(birefnet.PROVIDERS),
    }
    return birefnet.predict_alpha, info


# ── Fixtures and output locations ───────────────────────────────────────────


def _split_gs(uri: str) -> tuple[str, str]:
    rest = uri[len("gs://") :]
    bucket, _, prefix = rest.partition("/")
    return bucket, prefix.strip("/")


def collect_fixtures(src: str, only: set[str] | None, workdir: Path) -> list[Path]:
    """Fixture image paths, sorted by name. A gs:// source is downloaded first."""
    if src.startswith("gs://"):
        from google.cloud import storage

        bucket_name, prefix = _split_gs(src)
        client = storage.Client()
        dest = workdir / "fixtures"
        dest.mkdir(parents=True, exist_ok=True)
        for blob in client.list_blobs(bucket_name, prefix=f"{prefix}/" if prefix else None):
            name = blob.name.rsplit("/", 1)[-1]
            nested = "/" in blob.name[len(prefix) :].strip("/")
            if name.lower().endswith(FIXTURE_EXTS) and not nested:
                blob.download_to_filename(str(dest / name), timeout=600)
        root = dest
    else:
        root = Path(src)
    paths = sorted(p for p in root.iterdir() if p.is_file() and p.suffix.lower() in FIXTURE_EXTS)
    if only is not None:
        paths = [p for p in paths if p.name in only or p.stem in only]
    stems = [p.stem for p in paths]
    if len(set(stems)) != len(stems):
        raise SystemExit("two fixtures share a name stem; their PNGs would collide")
    return paths


def resolve_out(template: str, exec_env: str) -> str:
    return template.format(
        exec_env=exec_env,
        task=os.environ.get("CLOUD_RUN_TASK_INDEX", "0"),
        run=uuid.uuid4().hex[:8],
    )


def _upload_dir(local: Path, uri: str) -> None:
    from google.cloud import storage

    bucket_name, prefix = _split_gs(uri)
    bucket = storage.Client().bucket(bucket_name)
    for f in sorted(local.iterdir()):
        name = f"{prefix}/{f.name}" if prefix else f.name
        bucket.blob(name).upload_from_filename(str(f), timeout=600)


def alpha_sha256(alpha: np.ndarray) -> str:
    """Hash of the raw alpha plane (shape-prefixed), independent of PNG encoding."""
    h = hashlib.sha256(f"{alpha.shape[0]}x{alpha.shape[1]}:".encode())
    h.update(np.ascontiguousarray(alpha, dtype=np.uint8).tobytes())
    return h.hexdigest()


def write_png(alpha: np.ndarray, path: Path) -> None:
    Image.fromarray(np.ascontiguousarray(alpha, dtype=np.uint8)).save(path, format="PNG")


def read_png(path: Path) -> np.ndarray:
    with Image.open(path) as im:
        if im.mode != "L":
            raise InputMismatchError(f"{path} is mode {im.mode}, not L")
        return np.array(im)


def _emit(tag: str, **payload: Any) -> None:
    print(f"{tag} {canonical_json(payload)}", flush=True)


# ── generate ────────────────────────────────────────────────────────────────


def generate(
    impl: str,
    fixtures_src: str,
    out: str,
    only: set[str] | None = None,
    expect: int | None = None,
    status: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from app.cropper import tiered

    status = status if status is not None else {}
    started = time.time()
    model = model_info(impl)
    fp = host_fingerprint(model)
    key = fingerprint_key(fp)
    alpha_fn, impl_info = _rembg_alpha_fn() if impl == "rembg" else _direct_alpha_fn()
    facts = host_facts()
    _emit(
        "GOLDEN_HOST",
        key=key,
        fingerprint=fp,
        nproc=facts["nproc"],
        model_file=model["file"],
    )

    with tempfile.TemporaryDirectory(prefix="golden-") as tmp:
        tmpdir = Path(tmp)
        paths = collect_fixtures(fixtures_src, only, tmpdir)
        if expect is not None and len(paths) != expect:
            raise SystemExit(f"expected {expect} fixtures, found {len(paths)}")
        if not paths:
            raise SystemExit(f"no fixtures under {fixtures_src}")
        target = resolve_out(out, fp["exec_env"])
        outdir = tmpdir / "out" if target.startswith("gs://") else Path(target)
        outdir.mkdir(parents=True, exist_ok=True)

        fixtures: dict[str, Any] = {}
        for i, path in enumerate(paths):
            status.update(state="running", done=i, total=len(paths))
            data = path.read_bytes()
            _full, work, _scale = tiered._load(data)
            padded, p = _padded_input(work)
            t0 = time.perf_counter()
            alpha = alpha_fn(padded)
            elapsed = round(time.perf_counter() - t0, 2)
            if alpha.shape != padded.shape[:2] or alpha.dtype != np.uint8:
                raise SystemExit(f"{path.name}: alpha {alpha.dtype} {alpha.shape} is not uint8 HxW")
            png = f"{path.stem}.png"
            write_png(alpha, outdir / png)
            entry = {
                "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data),
                "work_shape": list(work.shape[:2]),
                "pad": p,
                "padded_shape": list(padded.shape[:2]),
                "alpha_png": png,
                "alpha": {key: alpha_sha256(alpha)},
            }
            fixtures[path.name] = entry
            _emit("GOLDEN", fixture=path.name, alpha_sha256=entry["alpha"][key], elapsed_s=elapsed)

        manifest = {
            "format": MANIFEST_FORMAT,
            "kind": "run",
            "generator": "scripts/golden_masks.py",
            "padding": {
                "birefnet_pad": tiered.BIREFNET_PAD,
                "ring_frac": RING_FRAC,
                "work_long": tiered.WORK_LONG,
            },
            "fingerprints": {key: fp},
            "golden_fingerprint": key,
            "runs": [
                {
                    "impl": impl,
                    **impl_info,
                    "fingerprint": key,
                    "host": facts,
                    "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
                    "elapsed_s": round(time.time() - started, 1),
                    "model_file": model["file"],
                    "md5_matches_rembg": model["md5_matches_rembg"],
                    "packages": installed_packages(),
                }
            ],
            "fixtures": dict(sorted(fixtures.items())),
            "tolerance": None,
        }
        (outdir / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        if target.startswith("gs://"):
            _upload_dir(outdir, target)
        status.update(state="done", done=len(paths), total=len(paths), out=target)
        _emit("GOLDEN_DONE", out=target, key=key, fixtures=len(fixtures))
        return manifest


# ── hash (verify + merge runs into goldens) ─────────────────────────────────


def load_manifest(run_dir: Path) -> dict[str, Any]:
    m = json.loads((run_dir / MANIFEST_NAME).read_text())
    if m.get("format") != MANIFEST_FORMAT:
        raise InputMismatchError(
            f"{run_dir}: manifest format {m.get('format')!r}, not {MANIFEST_FORMAT}"
        )
    return m


def verify_pngs(run_dir: Path, manifest: Mapping[str, Any]) -> None:
    """Each PNG decodes to the alpha its manifest records for its golden fingerprint."""
    key = manifest["golden_fingerprint"]
    for name, fx in manifest["fixtures"].items():
        got = alpha_sha256(read_png(run_dir / fx["alpha_png"]))
        if got != fx["alpha"][key]:
            raise InputMismatchError(
                f"{run_dir}/{fx['alpha_png']} does not match the manifest ({name})"
            )


_INPUT_FIELDS = ("sha256", "work_shape", "pad", "padded_shape")


def merge_manifests(manifests: list[Mapping[str, Any]], goldens_index: int = 0) -> dict[str, Any]:
    """One goldens manifest from several runs: per fixture, an alpha hash per fingerprint."""
    if not manifests:
        raise InputMismatchError("no runs to merge")
    base = manifests[goldens_index]
    names = set(base["fixtures"])
    for m in manifests:
        if set(m["fixtures"]) != names:
            raise InputMismatchError("runs cover different fixtures")
        if m["padding"] != base["padding"]:
            raise InputMismatchError("runs padded differently")
    fingerprints: dict[str, Any] = {}
    fixtures: dict[str, Any] = {}
    for name in sorted(names):
        ref = base["fixtures"][name]
        merged = {k: ref[k] for k in (*_INPUT_FIELDS, "bytes", "alpha_png")}
        alphas: dict[str, str] = {}
        for m in manifests:
            fx = m["fixtures"][name]
            for field in _INPUT_FIELDS:
                if fx[field] != ref[field]:
                    raise InputMismatchError(f"{name}: runs disagree on {field}")
            for key, digest in fx["alpha"].items():
                if key in alphas and alphas[key] != digest:
                    raise InputMismatchError(
                        f"{name}: two runs on fingerprint {key} gave different alphas "
                        "(the same host is not deterministic)"
                    )
                alphas[key] = digest
        merged["alpha"] = dict(sorted(alphas.items()))
        fixtures[name] = merged
    for m in manifests:
        fingerprints.update(m["fingerprints"])
    return {
        "format": MANIFEST_FORMAT,
        "kind": "goldens",
        "generator": "scripts/golden_masks.py",
        "padding": base["padding"],
        "fingerprints": dict(sorted(fingerprints.items())),
        "golden_fingerprint": base["golden_fingerprint"],
        "runs": [r for m in manifests for r in m["runs"]],
        "fixtures": fixtures,
        "tolerance": None,
    }


def parse_tolerance(text: str) -> dict[str, Any]:
    parts = [p.strip() for p in text.split(",")]
    if len(parts) != 3:
        raise argparse.ArgumentTypeError(
            "tolerance is T,F,N (alpha levels, alpha pixel fraction, mask pixels)"
        )
    return {
        "max_alpha_diff": int(parts[0]),
        "max_alpha_pixel_frac": float(parts[1]),
        "max_mask_pixels": int(parts[2]),
    }


def hash_runs(
    run_dirs: list[Path],
    out: Path,
    goldens_from: Path | None = None,
    tolerance: dict[str, Any] | None = None,
) -> dict[str, Any]:
    manifests = [load_manifest(d) for d in run_dirs]
    for d, m in zip(run_dirs, manifests, strict=True):
        verify_pngs(d, m)
    source = goldens_from or run_dirs[0]
    idx = [d.resolve() for d in run_dirs].index(source.resolve())
    merged = merge_manifests(manifests, idx)
    merged["tolerance"] = tolerance
    out.mkdir(parents=True, exist_ok=True)
    for fx in merged["fixtures"].values():
        shutil.copyfile(source / fx["alpha_png"], out / fx["alpha_png"])
    (out / MANIFEST_NAME).write_text(json.dumps(merged, indent=2, sort_keys=True) + "\n")
    return merged


# ── compare ─────────────────────────────────────────────────────────────────


def binary_mask(
    alpha_full: np.ndarray, pad: int = 0, work_shape: Iterable[int] | None = None
) -> np.ndarray:
    """The mask `tiered.birefnet_mask` builds from a padded alpha plane.

    Crop back to the work frame, threshold, then the 5x5 elliptical close.
    """
    import cv2

    h, w = (list(work_shape) if work_shape is not None else alpha_full.shape[:2])[:2]
    alpha = alpha_full[pad : pad + h, pad : pad + w]
    mask = (alpha > MASK_THRESHOLD).astype(np.uint8) * 255
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (MASK_CLOSE_KERNEL, MASK_CLOSE_KERNEL))
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k)


IDENTICAL_STATS: dict[str, Any] = {
    "identical": True,
    "max_alpha_diff": 0,
    "alpha_pixels": 0,
    "alpha_pixel_frac": 0.0,
    "mask_pixels": 0,
}


def diff_alpha(
    a: np.ndarray, b: np.ndarray, pad: int = 0, work_shape: Iterable[int] | None = None
) -> dict[str, Any]:
    """How far apart two padded alpha planes are: in alpha, and in tiered's mask.

    `pad` and `work_shape` are the fixture's (the manifest records both); the
    defaults treat the whole plane as the work frame.
    """
    if a.shape != b.shape:
        raise InputMismatchError(f"alpha shapes differ: {a.shape} vs {b.shape}")
    d = np.abs(a.astype(np.int16) - b.astype(np.int16))
    n = int(np.count_nonzero(d))
    if n == 0:
        return dict(IDENTICAL_STATS)
    masks = binary_mask(a, pad, work_shape), binary_mask(b, pad, work_shape)
    return {
        "identical": False,
        "max_alpha_diff": int(d.max()),
        "alpha_pixels": n,
        "alpha_pixel_frac": n / d.size,
        "mask_pixels": int(np.count_nonzero(masks[0] != masks[1])),
    }


def within(stats: Mapping[str, Any], tol: Mapping[str, Any]) -> bool:
    return (
        stats["max_alpha_diff"] <= tol["max_alpha_diff"]
        and stats["alpha_pixel_frac"] <= tol["max_alpha_pixel_frac"]
        and stats["mask_pixels"] <= tol["max_mask_pixels"]
    )


def compare_dirs(
    a: Path, others: list[Path], tolerance: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    """Compare every directory in `others` with `a`, fixture by fixture."""
    ma = load_manifest(a)
    tol = tolerance if tolerance is not None else ma.get("tolerance")
    pairs: list[dict[str, Any]] = []
    worst = {k: v for k, v in IDENTICAL_STATS.items() if k != "identical"}
    for b in others:
        mb = load_manifest(b)
        missing = sorted(set(ma["fixtures"]) - set(mb["fixtures"]))
        if missing:
            raise InputMismatchError(f"{b} is missing fixtures: {missing}")
        per: dict[str, Any] = {}
        for name, fa in sorted(ma["fixtures"].items()):
            fb = mb["fixtures"][name]
            for field in _INPUT_FIELDS:
                if fa[field] != fb[field]:
                    raise InputMismatchError(f"{name}: {a} and {b} disagree on {field}")
            ha = fa["alpha"][ma["golden_fingerprint"]]
            hb = fb["alpha"][mb["golden_fingerprint"]]
            if ha == hb:
                stats = dict(IDENTICAL_STATS)
            else:
                stats = diff_alpha(
                    read_png(a / fa["alpha_png"]),
                    read_png(b / fb["alpha_png"]),
                    fa["pad"],
                    fa["work_shape"],
                )
            per[name] = stats
            for k in worst:
                worst[k] = max(worst[k], stats[k])
        pairs.append(
            {
                "a": str(a),
                "b": str(b),
                "a_fingerprint": ma["golden_fingerprint"],
                "b_fingerprint": mb["golden_fingerprint"],
                "same_fingerprint": ma["golden_fingerprint"] == mb["golden_fingerprint"],
                "fixtures": per,
            }
        )
    exact = worst["alpha_pixels"] == 0
    derived = {
        "max_alpha_diff": 2 * worst["max_alpha_diff"],
        "max_alpha_pixel_frac": 2 * worst["alpha_pixel_frac"],
        "max_mask_pixels": 2 * worst["mask_pixels"],
    }
    over_stop = {k: derived[k] > STOP_LINE[k] for k in STOP_LINE}
    verdict = (
        "exact" if exact else ("within" if tol is not None and within(worst, tol) else "outside")
    )
    return {
        "verdict": verdict,
        "worst": worst,
        "tolerance": tol,
        "derived_tolerance": derived,
        "derived_over_stop_line": over_stop,
        "ask_jason": any(over_stop.values()),
        "pairs": pairs,
    }


# ── fingerprint ─────────────────────────────────────────────────────────────


def fingerprint_report(impl: str) -> dict[str, Any]:
    model = model_info(impl)
    fp = host_fingerprint(model)
    return {
        "key": fingerprint_key(fp),
        "fingerprint": fp,
        "host": host_facts(),
        "model_file": model["file"],
        "md5_matches_rembg": model["md5_matches_rembg"],
        "packages": installed_packages(),
    }


# ── Cloud Run service wrapper ───────────────────────────────────────────────


def _serve_status(status: dict[str, Any]) -> None:
    """Listen on $PORT at once so a Cloud Run service passes its startup probe."""

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - http.server's name
            body = canonical_json(status).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args: Any) -> None:
            return

    port = int(os.environ.get("PORT", "8080"))
    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)  # noqa: S104
    threading.Thread(target=server.serve_forever, daemon=True).start()


# ── CLI ─────────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = ap.add_subparsers(dest="mode", required=True)

    g = sub.add_parser("generate", help="run BiRefNet on the fixtures and write alpha PNGs")
    g.add_argument("--impl", choices=IMPLS, required=True)
    g.add_argument("--fixtures", required=True, help="local dir or gs://bucket[/prefix]")
    g.add_argument("--out", required=True, help="dir or gs://...; may use {exec_env} {task} {run}")
    g.add_argument("--only", help="comma-separated fixture names or stems")
    g.add_argument("--expect", type=int, help="fail unless exactly this many fixtures")
    g.add_argument("--serve", action="store_true", help="answer HTTP on $PORT (Cloud Run service)")

    h = sub.add_parser("hash", help="verify runs and merge them into a goldens manifest")
    h.add_argument("runs", nargs="+", type=Path)
    h.add_argument("--out", required=True, type=Path)
    h.add_argument("--goldens-from", type=Path, help="run whose PNGs become the goldens")
    h.add_argument("--tolerance", type=parse_tolerance, help="T,F,N")

    c = sub.add_parser("compare", help="compare runs or goldens with the first directory")
    c.add_argument("a", type=Path)
    c.add_argument("others", nargs="+", type=Path)
    c.add_argument("--tolerance", type=parse_tolerance, help="T,F,N; default: A's manifest")
    c.add_argument("--report-only", action="store_true", help="exit 0 unless inputs differ")
    c.add_argument("--json", type=Path, help="also write the report here")

    f = sub.add_parser("fingerprint", help="print this host's fingerprint; no inference")
    f.add_argument("--impl", choices=IMPLS, default="rembg")
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.mode == "generate":
            status: dict[str, Any] = {"state": "starting"}
            if args.serve:
                _serve_status(status)
            only = set(args.only.split(",")) if args.only else None
            try:
                generate(args.impl, args.fixtures, args.out, only, args.expect, status)
            except BaseException as exc:
                status.update(state="failed", error=repr(exc)[:500])
                if not args.serve:
                    raise
                _emit("GOLDEN_FAILED", error=repr(exc)[:500])
            if args.serve:  # keep the instance up so Cloud Run does not restart it
                threading.Event().wait()
            return 0
        if args.mode == "hash":
            merged = hash_runs(args.runs, args.out, args.goldens_from, args.tolerance)
            print(
                f"wrote {args.out / MANIFEST_NAME}: {len(merged['fixtures'])} fixtures, "
                f"{len(merged['fingerprints'])} fingerprints"
            )
            return 0
        if args.mode == "compare":
            report = compare_dirs(args.a, args.others, args.tolerance)
            text = json.dumps(report, indent=2, sort_keys=True)
            print(text)
            if args.json:
                args.json.write_text(text + "\n")
            if args.report_only or report["verdict"] in ("exact", "within"):
                return 0
            return 1
        if args.mode == "fingerprint":
            print(json.dumps(fingerprint_report(args.impl), indent=2, sort_keys=True))
            return 0
    except InputMismatchError as exc:
        print(f"input mismatch: {exc}", file=sys.stderr)
        return 2
    return 2


if __name__ == "__main__":
    sys.exit(main())
