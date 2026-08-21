#!/usr/bin/env python3
"""Upload local fixture images to the GCS bucket.

Counterpart to `scripts/fetch_fixtures.py`. Use when adding a new
fixture: drop the image into `tests/fixtures/`, run the label script to
bootstrap a sidecar, then push the image here so other devs + future CI
can fetch it.

Usage:
    python scripts/push_fixtures.py                # upload every image
    python scripts/push_fixtures.py --only NAME   # upload one (stem, e.g. "landscape")
    python scripts/push_fixtures.py --dry-run     # list what would be uploaded

Run from `services/preprocess/`.

Requires ADC with `roles/storage.objectAdmin` on
`gs://neonbinder-dev-preprocess-fixtures` — the `developer_emails` in the
infrastructure repo's `environments/dev.tfvars` have this.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

FIXTURES_BUCKET = "gs://neonbinder-dev-preprocess-fixtures"
FIXTURES_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
SUPPORTED_EXTS = (".jpg", ".jpeg", ".png", ".webp")


def _local_images() -> list[Path]:
    return sorted(
        p for p in FIXTURES_DIR.iterdir() if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS
    )


def _upload(src: Path) -> bool:
    uri = f"{FIXTURES_BUCKET}/{src.name}"
    result = subprocess.run(
        ["gcloud", "storage", "cp", str(src), uri],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"  ERROR: {result.stderr.strip() or result.stdout.strip()}", file=sys.stderr)
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--only",
        help="upload only the image whose stem matches (no extension)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print what would be uploaded without actually pushing",
    )
    args = parser.parse_args()

    images = _local_images()
    if args.only:
        images = [p for p in images if p.stem == args.only]
        if not images:
            print(f"No local image with stem {args.only!r} under {FIXTURES_DIR}")
            return 1

    if not images:
        print(f"No images under {FIXTURES_DIR} — nothing to upload.")
        return 0

    print(f"uploading {len(images)} image(s) to {FIXTURES_BUCKET}")
    uploaded = 0
    for src in images:
        print(f"  {src.name} ({src.stat().st_size:,} bytes)")
        if args.dry_run:
            continue
        if _upload(src):
            uploaded += 1

    print(f"\nsummary: {uploaded} uploaded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
