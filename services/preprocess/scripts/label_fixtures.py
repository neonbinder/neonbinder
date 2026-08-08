#!/usr/bin/env python3
"""Bootstrap fixture sidecars by running the real pipeline.

Usage:
    python scripts/label_fixtures.py                    # missing sidecars only
    python scripts/label_fixtures.py --force            # overwrite existing
    python scripts/label_fixtures.py --fixture white-border-front.jpg

Requires ANTHROPIC_API_KEY in .env.local (or environment) and Vision ADC
(`gcloud auth application-default login`). Output YAML starts strict
(`equals:` on every classify field); edit the sidecar afterwards to loosen
player/team to `contains:` where Haiku drift is expected.
"""

from __future__ import annotations

import argparse
import sys
from io import BytesIO
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
load_dotenv(REPO_ROOT / ".env.local", override=False)

from app.classify import classify_card  # noqa: E402
from app.orient import detect_orientation  # noqa: E402

FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures"
SUPPORTED = {".jpg", ".jpeg", ".png", ".webp"}


def _rotate(image_bytes: bytes, degrees_ccw: int) -> bytes:
    if degrees_ccw % 360 == 0:
        return image_bytes
    with Image.open(BytesIO(image_bytes)) as img:
        fmt = img.format or "JPEG"
        rotated = img.rotate(degrees_ccw, expand=True)
        out = BytesIO()
        rotated.save(out, format=fmt)
        return out.getvalue()


def _matcher_or_null(value: str | None) -> dict[str, Any]:
    if value is None:
        return {"is_null": True}
    return {"equals": value}


def _label(image_path: Path) -> tuple[dict, dict]:
    """Return (sidecar_yaml_dict, debug_info_dict)."""
    image_bytes = image_path.read_bytes()
    orient = detect_orientation(image_bytes)
    rotated = _rotate(image_bytes, orient.rotation_degrees)
    classification = classify_card(rotated)

    sidecar = {
        "orient": {
            "rotation_degrees": orient.rotation_degrees,
        },
        "classify": {
            "side": classification.side,
            "player": _matcher_or_null(classification.player),
            "team": _matcher_or_null(classification.team),
            "card_number": _matcher_or_null(classification.card_number),
        },
    }
    debug = {
        "orient_confidence": round(orient.confidence, 3),
        "text_count": orient.text_count,
    }
    return sidecar, debug


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force",
        action="store_true",
        help="overwrite existing sidecars",
    )
    parser.add_argument(
        "--fixture",
        help="process only this fixture filename (e.g. white-border-front.jpg)",
    )
    args = parser.parse_args()

    candidates: list[tuple[Path, Path]] = []
    if not FIXTURES_DIR.exists():
        print(f"fixtures dir not found: {FIXTURES_DIR}")
        return 1
    for p in sorted(FIXTURES_DIR.iterdir()):
        if p.suffix.lower() not in SUPPORTED:
            continue
        if args.fixture and p.name != args.fixture:
            continue
        sidecar = p.with_suffix(".yaml")
        if sidecar.exists() and not args.force:
            print(f"skip {p.name} (sidecar exists; use --force to overwrite)")
            continue
        candidates.append((p, sidecar))

    if not candidates:
        print("nothing to do")
        return 0

    failures = 0
    for image_path, sidecar in candidates:
        print(f"→ {image_path.name} ({image_path.stat().st_size:,} bytes)")
        try:
            data, debug = _label(image_path)
        except Exception as exc:  # noqa: BLE001
            print(f"  FAILED: {exc}")
            failures += 1
            continue
        sidecar.write_text(yaml.safe_dump(data, sort_keys=False))
        print(f"  wrote {sidecar.name}")
        print(
            f"  observed: orient_confidence={debug['orient_confidence']}, "
            f"text_count={debug['text_count']}"
        )
        for line in yaml.safe_dump(data, sort_keys=False).splitlines():
            print(f"    {line}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
