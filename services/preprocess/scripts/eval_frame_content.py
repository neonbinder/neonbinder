#!/usr/bin/env python3
"""Run the FAST role's pixel stages over image directories as if no scan
resolution had been recorded, and report which stage settles each image.

Usage (from services/preprocess/):
    python scripts/eval_frame_content.py DIR_OR_GLOB [DIR_OR_GLOB ...]
    python scripts/eval_frame_content.py --reencode --quiet DIR
    python scripts/eval_frame_content.py --expect frame_content DIR

Each image's resolution metadata is removed in memory first, so
`scan_meta.is_card_sized_scan` defers exactly as it does for a scan that
carries none. By default that is lossless (the EXIF segment is dropped and the
JFIF density unit cleared, pixels untouched); `--reencode` decodes and
re-encodes instead (JPEG quality 95), which also perturbs the pixels and
shows how close each verdict is to its threshold.

Then the FAST order runs: `tiered.fast_tiered_verdict` (classical identity),
`quad.quad_crop`, `frame_content.frame_content_identity`. Per image it prints
the classical verdict, the quad reason, each frame-content check's numbers
(per side: ring fraction, content inset in full-res px, strongest margin line
coherence and its row) and the final stage: `frame`, `quad`, `frame_content`
or `escalate`. A summary follows. No Vision call is made, so the cascade's
text gate is not applied; every stage here returns before it.

Only the pixel modules are imported (the package `__init__` pulls in the
service's API clients), so this runs in a venv with just numpy, Pillow and
opencv-python-headless. Images stay where they are; nothing is written.
"""

from __future__ import annotations

import argparse
import glob
import io
import os
import struct
import sys
import types
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVICE_ROOT))

# Import the cropper's pixel modules without running `app/cropper/__init__.py`.
_pkg = types.ModuleType("app.cropper")
_pkg.__path__ = [str(SERVICE_ROOT / "app" / "cropper")]
sys.modules.setdefault("app.cropper", _pkg)

from PIL import Image, ImageOps  # noqa: E402

from app.cropper import frame_content, quad, scan_meta, tiered  # noqa: E402

SUPPORTED = {".jpg", ".jpeg", ".png"}
EXIF_ORIENTATION = 274


def _strip_jpeg(data: bytes) -> bytes | None:
    """Drop APP1/Exif and clear the JFIF density unit, losslessly.

    Returns None when the bytes are not a JPEG this can walk, or when EXIF
    carries a rotation (dropping it would change what the pixels mean).
    """
    if data[:2] != b"\xff\xd8":
        return None
    out = bytearray(b"\xff\xd8")
    i = 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            return None
        marker = data[i + 1]
        if marker in (0xDA, 0xD9):  # start of scan: the rest is entropy data
            out += data[i:]
            return bytes(out)
        length = struct.unpack(">H", data[i + 2 : i + 4])[0]
        seg = bytearray(data[i : i + 2 + length])
        if marker == 0xE1 and seg[4:10] == b"Exif\x00\x00":
            i += 2 + length
            continue
        if marker == 0xE0 and seg[4:9] == b"JFIF\x00":
            seg[11] = 0  # units: none (aspect ratio only)
            seg[12:16] = b"\x00\x01\x00\x01"
        out += seg
        i += 2 + length
    return None


def strip_resolution(data: bytes, reencode: bool) -> tuple[bytes, str]:
    """The image with no trustworthy resolution, and how that was done."""
    if not reencode:
        with Image.open(io.BytesIO(data)) as im:
            rotated = im.getexif().get(EXIF_ORIENTATION, 1) not in (None, 1)
            fmt = im.format
        if fmt == "JPEG" and not rotated:
            stripped = _strip_jpeg(data)
            if stripped is not None:
                return stripped, "lossless"
    with Image.open(io.BytesIO(data)) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=95)
    return buf.getvalue(), "reencoded"


def evaluate(path: str, reencode: bool) -> dict:
    data = Path(path).read_bytes()
    stripped, how = strip_resolution(data, reencode)
    row: dict = {"path": path, "strip": how}
    with Image.open(io.BytesIO(stripped)) as im:
        w, h = im.size
    row["size"] = (w, h)
    if scan_meta.is_card_sized_scan(stripped) is not None:
        row["final"] = "scan_metadata"  # the strip did not take; flagged in the summary
        return row
    accepted, classical = tiered.fast_tiered_verdict(stripped)
    row["classical"] = classical
    if accepted is not None:
        row["final"] = "frame"
        return row
    q = quad.quad_crop(stripped)
    row["quad"] = q.reason
    if q.crop_bytes is not None:
        row["final"] = "quad"
        return row
    fc = frame_content.frame_content_identity(
        stripped, classical_reason=classical, quad_reason=q.reason
    )
    row["fc"] = fc.reason
    row["fc_diag"] = fc.diagnostics
    row["final"] = "frame_content" if fc.accepted else "escalate"
    return row


def _expand(specs: list[str]) -> list[str]:
    paths: list[str] = []
    for spec in specs:
        if os.path.isdir(spec):
            found = glob.glob(os.path.join(spec, "**", "*"), recursive=True)
        else:
            found = glob.glob(spec, recursive=True)
        paths += [p for p in found if Path(p).suffix.lower() in SUPPORTED]
    return sorted(set(paths))


def _side_text(diag: dict) -> str:
    sides = diag.get("sides")
    if not sides:
        return ""
    inset = diag.get("inset_px", {})
    parts = []
    for name, v in sides.items():
        parts.append(
            f"{name[0]}:ring={v['ring']:.2f} in={inset.get(name)}px"
            f" edge={v['edge']:.2f}@{v['edge_row']} onset={v['onset']:.2f}"
        )
    return " ".join(parts)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("inputs", nargs="+", help="directories (searched recursively) or globs")
    ap.add_argument("--reencode", action="store_true", help="strip resolution by re-encoding")
    ap.add_argument("--quiet", action="store_true", help="summary only")
    ap.add_argument("--expect", help="final stage every image should reach; misses are listed")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 1)
    args = ap.parse_args()

    paths = _expand(args.inputs)
    if not paths:
        print("no images found", file=sys.stderr)
        return 2
    common = os.path.commonpath([os.path.dirname(p) for p in paths])
    with ProcessPoolExecutor(max_workers=args.jobs) as pool:
        rows = list(pool.map(evaluate, paths, [args.reencode] * len(paths), chunksize=4))

    finals: Counter = Counter()
    escalations: Counter = Counter()
    strips: Counter = Counter()
    misses = []
    for r in rows:
        name = os.path.relpath(r["path"], common)
        finals[r["final"]] += 1
        strips[r["strip"]] += 1
        if r["final"] == "escalate":
            escalations[(r.get("classical"), r.get("quad"), r.get("fc"))] += 1
        if args.expect and r["final"] != args.expect:
            misses.append(name)
        if not args.quiet:
            diag = r.get("fc_diag", {})
            print(
                f"{name}  {r['size'][0]}x{r['size'][1]}  aspect={diag.get('aspect', '-')}"
                f"  classical={r.get('classical', '-')}  quad={r.get('quad', '-')}"
                f"  fc={r.get('fc', '-')}  -> {r['final']}  {_side_text(diag)}"
            )

    n = len(rows)
    print(f"\n{n} images ({dict(strips)})")
    for stage in ("frame", "quad", "frame_content", "escalate", "scan_metadata"):
        if finals[stage]:
            print(f"  {stage:14s} {finals[stage]:5d}  {100 * finals[stage] / n:5.1f}%")
    if escalations:
        print("escalations by (classical, quad, frame_content):")
        for key, count in escalations.most_common():
            print(f"  {count:5d}  {key}")
    if args.expect:
        print(f"expected {args.expect}: {n - len(misses)}/{n}")
        for m in misses:
            print(f"  miss: {m}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
